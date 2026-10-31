import { useCallback, useEffect, useRef, useState } from "react";
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

type UseRecordSyncOptions = {
  user: User | null;
  isAuthReady: boolean;
  repository: LocalRecordRepository;
  localStore: IndexedDbRecordRepository;
  onRecordsChanged: () => void | Promise<void>;
};

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
  const syncPromiseRef = useRef<Promise<void> | null>(null);
  const autoSyncTimerRef = useRef<number | null>(null);
  const syncServiceRef = useRef(new RecordSyncService(supabase, localStore));

  const syncNow = useCallback(async () => {
    if (!user) return;
    if (syncPromiseRef.current) return syncPromiseRef.current;

    if (!navigator.onLine) {
      setSyncState((current) => ({ ...current, phase: "offline", errorMessage: "" }));
      return;
    }

    const promise = (async () => {
      setSyncState((current) => ({ ...current, phase: "syncing", errorMessage: "" }));
      try {
        await syncServiceRef.current.sync(user.id);
        await onRecordsChanged();
        setSyncState({
          phase: "idle",
          lastSyncedAt: new Date(),
          pendingChanges: 0,
          errorMessage: "",
        });
      } catch (error) {
        setSyncState((current) => ({
          ...current,
          phase: "error",
          errorMessage: error instanceof Error ? error.message : "同步失败，请稍后重试。",
        }));
      }
    })();

    syncPromiseRef.current = promise;
    try {
      await promise;
    } finally {
      syncPromiseRef.current = null;
    }
  }, [onRecordsChanged, user]);

  useEffect(() => {
    if (!isAuthReady) return;
    let isCancelled = false;

    async function configureScope() {
      if (!user) {
        localStore.setGuestScope();
        setSyncState(signedOutState);
        await onRecordsChanged();
        return;
      }

      const claimedCount = await localStore.claimGuestRecords(user.id);
      localStore.setUserScope(user.id);
      if (isCancelled) return;
      setSyncState((current) => ({
        ...current,
        phase: navigator.onLine ? "idle" : "offline",
        pendingChanges: Math.max(current.pendingChanges, claimedCount ? 1 : 0),
        errorMessage: "",
      }));
      await onRecordsChanged();
      if (!isCancelled) await syncNow();
    }

    void configureScope();
    return () => {
      isCancelled = true;
    };
  }, [isAuthReady, localStore, onRecordsChanged, syncNow, user]);

  useEffect(() => repository.subscribe(() => {
    if (!user) return;
    setSyncState((current) => ({
      ...current,
      phase: navigator.onLine ? current.phase : "offline",
      pendingChanges: current.pendingChanges + 1,
    }));
    if (autoSyncTimerRef.current) window.clearTimeout(autoSyncTimerRef.current);
    autoSyncTimerRef.current = window.setTimeout(() => void syncNow(), 650);
  }), [repository, syncNow, user]);

  useEffect(() => {
    if (!user) return;
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
  }, [syncNow, user]);

  return { syncState, syncNow };
}
