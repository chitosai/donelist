import { createClient } from "@supabase/supabase-js";
import { getSupabaseConfig } from "./supabaseConfig";

const { url, publishableKey } = getSupabaseConfig({
  VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
  VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
});

export const supabase = createClient(url, publishableKey);
