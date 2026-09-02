export async function apiRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...options })
  if (!response.ok) {
    if (response.status === 401) throw new Error('Neplatné přihlašovací údaje.')
    let problem: { title?: string; errors?: Record<string, string[]> } | undefined
    try {
      problem = await response.json() as typeof problem
    } catch { /* The response may not contain a problem-details body. */ }
    const validationMessage = problem?.errors && Object.values(problem.errors).flat()[0]
    throw new Error(validationMessage || problem?.title || 'Požadavek se nezdařil.')
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export async function antiforgeryToken() {
  const response = await apiRequest<{ token: string }>('/api/identity/antiforgery')
  return response.token
}
