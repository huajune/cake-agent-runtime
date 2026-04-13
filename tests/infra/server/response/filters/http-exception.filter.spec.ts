import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { IncidentReporterService } from '@observability/incidents/incident-reporter.service';
import { HttpExceptionFilter } from '@infra/server/response/filters/http-exception.filter';

describe('HttpExceptionFilter', () => {
  const createHost = (requestOverrides?: Partial<Request>) => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const request = {
      method: 'GET',
      url: '/api/test',
      ...requestOverrides,
    };
    const response = { status };

    const host = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as ArgumentsHost;

    return { host, request, response, status, json };
  };

  it('should notify system exception notifier for 500 errors', () => {
    const notifier = {
      notifyAsync: jest.fn(),
    } as unknown as jest.Mocked<IncidentReporterService>;
    const filter = new HttpExceptionFilter(notifier);
    const { host, status, json } = createHost();

    filter.catch(new Error('boom'), host);

    expect(notifier.notifyAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'http:internal-server-error',
        errorType: 'http_exception',
        title: 'HTTP 500 异常',
        apiEndpoint: 'GET /api/test',
        extra: expect.objectContaining({
          status: 500,
          code: 'INTERNAL_SERVER_ERROR',
          method: 'GET',
          url: '/api/test',
        }),
      }),
    );
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: 'INTERNAL_SERVER_ERROR',
        }),
      }),
    );
  });

  it('should not notify for 404 http exceptions', () => {
    const notifier = {
      notifyAsync: jest.fn(),
    } as unknown as jest.Mocked<IncidentReporterService>;
    const filter = new HttpExceptionFilter(notifier);
    const { host, status } = createHost();

    filter.catch(new HttpException('not found', HttpStatus.NOT_FOUND), host);

    expect(notifier.notifyAsync).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(404);
  });
});
