export function compact(value: string) {
  return value.length > 18 ? value.slice(0, 8) + "..." + value.slice(-6) : value;
}
