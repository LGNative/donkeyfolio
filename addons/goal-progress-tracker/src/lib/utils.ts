import { twMerge } from "tailwind-merge";
import clsx, { ClassValue } from "clsx";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function toFiniteAmount(value: unknown, fallback = 0) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) ? amount : fallback;
}
