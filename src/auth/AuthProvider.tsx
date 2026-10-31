import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";

type SignUpResult = {
  isEmailConfirmationRequired: boolean;
};

type AuthContextValue = {
  user: User | null;
  isAuthReady: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<SignUpResult>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);

  useEffect(() => {
    let isCancelled = false;
    let isAuthEventReceived = false;

    supabase.auth.getSession().then(({ data, error }) => {
      // A session event is newer than this initial storage read.
      if (isCancelled || isAuthEventReceived) return;
      if (error) console.error("读取登录状态失败", error);
      setUser(data.session?.user ?? null);
      setIsAuthReady(true);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      if (isCancelled) return;
      isAuthEventReceived = true;
      setUser(session?.user ?? null);
      setIsAuthReady(true);
    });

    return () => {
      isCancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    isAuthReady,
    async signIn(email, password) {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    },
    async signUp(email, password) {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) throw error;
      return { isEmailConfirmationRequired: !data.session };
    },
    async signOut() {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    },
  }), [isAuthReady, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth 必须在 AuthProvider 内使用。");
  return value;
}
