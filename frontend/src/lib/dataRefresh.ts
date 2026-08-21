export const DATA_CHANGED_EVENT = 'finstrat:data-changed'
export const DATA_REFRESH_INTERVAL_MS = 5_000

export function notifyDataChanged() {
  window.dispatchEvent(new Event(DATA_CHANGED_EVENT))
}
