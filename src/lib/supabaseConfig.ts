type SupabaseEnvironment = {
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_PUBLISHABLE_KEY?: string;
};

export function getSupabaseConfig(environment: SupabaseEnvironment) {
  const url = environment.VITE_SUPABASE_URL?.trim();
  const publishableKey = environment.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

  if (!url || !publishableKey) {
    throw new Error("缺少 Supabase 环境变量，请检查当前模式的 .env.[mode].local 或部署环境变量。");
  }

  return { url, publishableKey };
}
