import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error("缺少 Supabase 环境变量，请检查 .env.local。");
}

export const supabase = createClient(supabaseUrl, supabasePublishableKey);
