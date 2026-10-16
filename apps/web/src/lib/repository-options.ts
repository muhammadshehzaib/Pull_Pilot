import { api, type PaginationMeta } from './api';

export interface RepositoryOption {
  id: string;
  fullName: string;
  isActive: boolean;
}

/** Repository pickers must not depend on the current review/repository page. */
export async function loadRepositoryOptions(signal?: AbortSignal): Promise<RepositoryOption[]> {
  const repositories = new Map<string, RepositoryOption>();
  let page = 1;
  let totalPages = 1;
  do {
    signal?.throwIfAborted();
    const result = await api<{ repositories: RepositoryOption[]; pagination: PaginationMeta }>(
      `/api/repositories?limit=100&page=${page}`, { signal },
    );
    for (const repository of result.repositories) repositories.set(repository.id, repository);
    totalPages = result.pagination.totalPages;
    page++;
  } while (page <= totalPages);
  return [...repositories.values()];
}
