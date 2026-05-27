import { existsSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { HOME_DIR } from "@thxp/shared";

const DAILY_USAGE_FILE = join(HOME_DIR, "daily_usage.json");

interface DailyUsageStore {
  date: string;
  models: Record<string, number>;
}

let cachedUsage: DailyUsageStore | null = null;

function getTodayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function loadDailyUsage(): DailyUsageStore {
  const today = getTodayString();
  if (cachedUsage && cachedUsage.date === today) return cachedUsage;
  try {
    if (existsSync(DAILY_USAGE_FILE)) {
      const data = JSON.parse(readFileSync(DAILY_USAGE_FILE, "utf-8"));
      if (data?.date === today) {
        cachedUsage = data;
        return data;
      }
    }
  } catch {}
  cachedUsage = { date: today, models: {} };
  saveDailyUsage(cachedUsage);
  return cachedUsage;
}

function saveDailyUsage(data: DailyUsageStore): void {
  try {
    writeFileSync(DAILY_USAGE_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch {}
}

export function recordModelUsage(
  providerName: string,
  modelName: string,
  tokens: number
): void {
  const data = loadDailyUsage();
  const key = `${providerName.toLowerCase()},${modelName.toLowerCase()}`;
  data.models[key] = (data.models[key] || 0) + tokens;
  saveDailyUsage(data);
}

export function getModelUsage(
  providerName: string,
  modelName: string
): number {
  const data = loadDailyUsage();
  return data.models[`${providerName.toLowerCase()},${modelName.toLowerCase()}`] || 0;
}
