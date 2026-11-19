describe('Browser handling of dashboard IP denial', () => {
  const replace = jest.fn();
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

  beforeEach(() => {
    jest.resetModules();
    replace.mockClear();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { replace } },
    });
  });
  afterAll(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  it('redirects concurrent denials only once with a full navigation', async () => {
    const { redirectIfDashboardIpDenied } = await import('../../web/src/api/dashboard-access');
    redirectIfDashboardIpDenied(403, 'DASHBOARD_IP_DENIED');
    redirectIfDashboardIpDenied(403, 'DASHBOARD_IP_DENIED');
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/web/access-denied');
  });

  it('does not misclassify feature restrictions or service failures as network identity denial', async () => {
    const { redirectIfDashboardIpDenied } = await import('../../web/src/api/dashboard-access');
    redirectIfDashboardIpDenied(403, 'FORBIDDEN');
    redirectIfDashboardIpDenied(401, 'UNAUTHORIZED');
    redirectIfDashboardIpDenied(500, 'DASHBOARD_IP_DENIED');
    redirectIfDashboardIpDenied(200, undefined);
    expect(replace).not.toHaveBeenCalled();
  });

  it('redirects a denied fetch stream while preserving its response body', async () => {
    const { checkDashboardStreamAccess } = await import('../../web/src/api/dashboard-access');
    const body = { success: false, error: { code: 'DASHBOARD_IP_DENIED' } };
    const response = Response.json(body, { status: 403 });
    await checkDashboardStreamAccess(response);
    expect(replace).toHaveBeenCalledWith('/web/access-denied');
    expect(await response.json()).toEqual(body);
  });

  it('leaves ordinary HTTP and malformed error responses to the original caller', async () => {
    const { checkDashboardStreamAccess } = await import('../../web/src/api/dashboard-access');
    for (const response of [
      new Response('event: data\n\n', { status: 200 }),
      new Response('<html>proxy error</html>', { status: 403 }),
      Response.json({ error: { code: 'FORBIDDEN' } }, { status: 403 }),
    ]) {
      await checkDashboardStreamAccess(response);
      expect(response.bodyUsed).toBe(false);
    }
    expect(replace).not.toHaveBeenCalled();
  });
});
