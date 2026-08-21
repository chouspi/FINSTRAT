export async function apiRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...options })
  if (!response.ok) {
    throw new Error(response.status === 401 ? 'Neplatné přihlašovací údaje.' : 'Požadavek se nezdařil.')
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export async function antiforgeryToken() {
  const response = await apiRequest<{ token: string }>('/api/identity/antiforgery')
  return response.token
}
