/** A provider's explicit business response, without retaining its HTTP request or credentials. */
export class ProviderBusinessError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderBusinessError';
  }
}
