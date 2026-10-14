export class RepositoryAccessError extends Error {
  constructor(public readonly status: 403 | 503 = 403) {
    super(status === 403
      ? 'GitHub repository access could not be confirmed for your account.'
      : 'GitHub access verification is temporarily unavailable. Try again later.');
    this.name = 'RepositoryAccessError';
  }
}
