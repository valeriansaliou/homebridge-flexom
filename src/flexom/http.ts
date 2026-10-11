const REQUEST_TIMEOUT = 15_000; /* ms */

export class FlexomHttpError extends Error {
  readonly status: number;

  readonly path: string;

  constructor({
    method,
    path,
    status,
  }: {
    method: string;
    path: string;
    status: number;
  }) {
    super(`${method} ${path} failed with HTTP ${status}`);
    this.name = 'FlexomHttpError';
    this.status = status;
    this.path = path;
  }
}

export type HttpRequest = {
  method?: 'GET' | 'POST' | 'PUT';
  path: string;
  body?: Record<string, string | number>;
};

export function createHttpClient({
  baseUrl,
  getHeaders,
  encoding,
}: {
  baseUrl: string;
  getHeaders: () => Record<string, string>;
  encoding: 'json' | 'form';
}) {
  return async <T>({ method = 'GET', path, body }: HttpRequest): Promise<T> => {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...getHeaders(),
    };
    let payload: string | undefined;
    if (body) {
      if (encoding === 'json') {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      } else {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        payload = new URLSearchParams(
          Object.entries(body).map(([key, value]): [string, string] => [
            key,
            String(value),
          ]),
        ).toString();
      }
    }

    const url = new URL(
      `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`,
    );
    const response = await fetch(url, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!response.ok) {
      throw new FlexomHttpError({ method, path, status: response.status });
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  };
}
