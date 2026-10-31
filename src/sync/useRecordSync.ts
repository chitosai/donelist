import { useCallback, useEffect, useRef, useState } from "react";
import { liveQuery } from "dexie";
import type { User } from "@supabase/supabase-js";
import type { IndexedDbRecordRepository } from "../data/IndexedDbRecordRepository";
import type { LocalRecordRepository } from "../data/LocalRecordRepository";
import { supabase } from "../lib/supabase";
import { RecordSyncService } from "./RecordSyncService";

export type SyncPhase = "signed-out" | "idle" | "syncing" | "offline" | "error";

export type SyncState = {
  phase: SyncPhase;
  lastSyncedAt: Date | null;
  pendingChanges: number;
  errorMessage: string;
};

export type GuestMergeRequest = {
  userId: string;
  scopeVersion: number;
  recordIds: string[];
  isMerging: boolean;
  errorMessage: string;
};

type UseRecordSyncOptions = {
  user: User | null;
  isAuthReady: boolean;
  repository: LocalRecordRepository;
  localStore: IndexedDbRecordRepository;
  onRecordsChanged: () => void | Promise<void>;
};

const AUTO_SYNC_DELAY_MS = 1_000;

const signedOutState: SyncState = {
  phase: "signed-out",
  lastSyncedAt: null,
  pendingChanges: 0,
  errorMessage: "",
};

export function useRecordSync({
  user,
  isAuthReady,
  repository,
  localStore,
  onRecordsChanged,
}: UseRecordSyncOptions) {
  const [syncState, setSyncState] = useState<SyncState>(signedOutState);
  const [guestMergeRequest, setGuestMergeRequest] = useState<GuestMergeRequest | null>(null);
  const userId = user?.id ?? null;
  const activeUserIdRef = useRef<string | null>(null);
  const scopeVersionRef = useRef(0);
  const readyScopeVersionRef = useRef<number | null>(null);
  const mergingScopeVersionRef = useRef<number | null>(null);
  const syncPromiseRef = useRef<{ scopeVersion: number; promise: Promise<void> } | null>(null);
  const autoSyncTimerRef = useRef<number | null>(null);
  const syncServiceRef = useRef(new RecordSyncService(supabase, localStore));

  const syncNow = useCallback(async () => {
    const scopeVersion = scopeVersionRef.current;
    if (!userId || activeUserIdRef.current !== userId || readyScopeVersionRef.current !== scopeVersion) return;
    if (syncPromiseRef.current?.scopeVersion === scopeVersion) return syncPromiseRef.current.promise;
    const isCurrentScope = () => scopeVersionRef.current === scopeVersion && activeUserIdRef.current === userId;

    if (!navigator.onLine) {
      setSyncState((current) => ({ ...current, phase: "offline", errorMessage: "" }));
      return;
    }

    const promise = (async () => {
      setSyncState((current) => ({ ...current, phase: "syncing", errorMessage: "" }));
      try {
        await syncServiceRef.current.sync(userId);
        if (!isCurrentScope()) return;
        await onRecordsChanged();
        if (!isCurrentScope()) return;
        const pendingChanges = await localStore.getPendingUploadCount(userId);
        if (!isCurrentScope()) return;
        setSyncState((current) => ({
          ...current,
          phase: "idle",
          lastSyncedAt: new Date(),
          pendingChanges,
          errorMessage: "",
        }));
        if (pendingChanges) {
          if (autoSyncTimerRef.current) window.clearTimeout(autoSyncTimerRef.current);
          autoSyncTimerRef.current = window.setTimeout(() => void syncNow(), AUTO_SYNC_DELAY_MS);
        }
      } catch (error) {
        if (!isCurrentScope()) return;
        setSyncState((current) => ({
          ...current,
          phase: "error",
          errorMessage: error instanceof Error ? error.message : "同步失败，请稍后重试。",
        }));
      }
    })();

    syncPromiseRef.current = { scopeVersion, promise };
    try {
      await promise;
    } finally {
      if (syncPromiseRef.current?.promise === promise) syncPromiseRef.current = null;
    }
  }, [localStore, onRecordsChanged, userId]);

  useEffect(() => {
    if (!isAuthReady) return;
    const scopeVersion = ++scopeVersionRef.current;
    activeUserIdRef.current = userId;
    readyScopeVersionRef.current = null;
    setGuestMergeRequest(null);
    const isCurrentScope = () => scopeVersionRef.current === scopeVersion;

    async function configureScope() {
      if (!userId) {
        localStore.setGuestScope();
        setSyncState(signedOutState);
        await onRecordsChanged();
        return;
      }

      localStore.setUserScope(userId);
      setSyncState({
        ...signedOutState,
        phase: navigator.onLine ? "idle" : "offline",
      });
      // Cached records are independent of outbox initialization and network I/O.
      await onRecordsChanged();
      if (!isCurrentScope()) return;
      await localStore.prepareUploadQueue(userId);
      if (!isCurrentScope()) return;
      const pendingChanges = await localStore.getPendingUploadCount(userId);
      if (!isCurrentScope()) return;
      setSyncState((current) => ({ ...current, pendingChanges }));
      const guestRecords = await localStore.getGuestRecords();
      if (!isCurrentScope()) return;
      if (guestRecords.length) {
        setGuestMergeRequest({
          userId,
          scopeVersion,
          recordIds: guestRecords.map((record) => record.id),
          isMerging: false,
          errorMessage: "",
        });
        return;
      }
      readyScopeVersionRef.current = scopeVersion;
      await syncNow();
    }

    void configureScope().catch((error) => {
      if (!isCurrentScope()) return;
      setSyncState((current) => ({
        ...current,
        phase: "error",
        errorMessage: error instanceof Error ? error.message : "读取本地记录失败，请刷新页面重试。",
      }));
    });
    return () => {
      if (isCurrentScope()) {
        scopeVersionRef.current += 1;
        readyScopeVersionRef.current = null;
        activeUserIdRef.current = null;
      }
    };
  }, [isAuthReady, localStore, onRecordsChanged, syncNow, userId]);

  const keepGuestRecords = useCallback(() => {
    if (!guestMergeRequest || guestMergeRequest.userId !== activeUserIdRef.current || guestMergeRequest.scopeVersion !== scopeVersionRef.current) return;
    const scopeVersion = scopeVersionRef.current;
    if (mergingScopeVersionRef.current === scopeVersion) return;
    setGuestMergeRequest(null);
    readyScopeVersionRef.current = scopeVersion;
    void syncNow();
  }, [guestMergeRequest, syncNow]);

  const mergeGuestRecords = useCallback(async () => {
    if (!guestMergeRequest || guestMergeRequest.userId !== activeUserIdRef.current || guestMergeRequest.scopeVersion !== scopeVersionRef.current) return;
    const scopeVersion = scopeVersionRef.current;
    if (mergingScopeVersionRef.current === scopeVersion) return;
    mergingScopeVersionRef.current = scopeVersion;
    setGuestMergeRequest((current) => current ? { ...current, isMerging: true, errorMessage: "" } : null);
    try {
      await localStore.claimGuestRecords(guestMergeRequest.userId, guestMergeRequest.recordIds);
    } catch (error) {
      if (scopeVersionRef.current === scopeVersion) {
        setGuestMergeRequest((current) => current ? {
          ...current,
          isMerging: false,
          errorMessage: error instanceof Error ? error.message : "合并失败，记录仍保留在本地，请重试。",
        } : null);
      }
      return;
    } finally {
      if (mergingScopeVersionRef.current === scopeVersion) mergingScopeVersionRef.current = null;
    }
    if (scopeVersionRef.current !== scopeVersion) return;
    setGuestMergeRequest(null);
    readyScopeVersionRef.current = scopeVersion;
    try {
      const pendingChanges = await localStore.getPendingUploadCount(guestMergeRequest.userId);
      if (scopeVersionRef.current !== scopeVersion) return;
      setSyncState((current) => ({ ...current, pendingChanges }));
      await onRecordsChanged();
      if (scopeVersionRef.current === scopeVersion) await syncNow();
    } catch (error) {
      if (scopeVersionRef.current !== scopeVersion) return;
      setSyncState((current) => ({
        ...current,
        phase: "error",
        errorMessage: error instanceof Error ? error.message : "刷新记录失败，请刷新页面重试。",
      }));
    }
  }, [guestMergeRequest, localStore, onRecordsChanged, syncNow]);

  useEffect(() => {
    if (!isAuthReady || !userId) return;
    const scopeVersion = scopeVersionRef.current;
    const subscription = liveQuery(() => localStore.getPendingUploadCount(userId)).subscribe({
      next(pendingChanges) {
        if (scopeVersionRef.current !== scopeVersion || activeUserIdRef.current !== userId) return;
        setSyncState((current) => ({ ...current, pendingChanges }));
        if (pendingChanges && readyScopeVersionRef.current === scopeVersion) {
          if (autoSyncTimerRef.current) window.clearTimeout(autoSyncTimerRef.current);
          autoSyncTimerRef.current = window.setTimeout(() => void syncNow(), AUTO_SYNC_DELAY_MS);
        }
      },
      error(error) {
        if (scopeVersionRef.current !== scopeVersion) return;
        setSyncState((current) => ({
          ...current,
          phase: "error",
          errorMessage: error instanceof Error ? error.message : "读取待上传记录失败，请刷新页面重试。",
        }));
      },
    });
    return () => subscription.unsubscribe();
  }, [isAuthReady, localStore, syncNow, userId]);

  useEffect(() => repository.subscribe(() => {
    if (!userId) return;
    setSyncState((current) => ({
      ...current,
      phase: navigator.onLine ? current.phase : "offline",
    }));
    if (autoSyncTimerRef.current) window.clearTimeout(autoSyncTimerRef.current);
    autoSyncTimerRef.current = window.setTimeout(() => void syncNow(), AUTO_SYNC_DELAY_MS);
  }), [repository, syncNow, userId]);

  useEffect(() => {
    if (!userId) return;
    const handleOnline = () => void syncNow();
    const handleOffline = () => setSyncState((current) => ({ ...current, phase: "offline" }));
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void syncNow();
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (autoSyncTimerRef.current) window.clearTimeout(autoSyncTimerRef.current);
    };
  }, [syncNow, userId]);

  return {
    syncState,
    syncNow,
    guestMergeRequest: guestMergeRequest?.userId === userId && guestMergeRequest?.scopeVersion === scopeVersionRef.current
      ? guestMergeRequest
      : null,
    mergeGuestRecords,
    keepGuestRecords,
  };
}
