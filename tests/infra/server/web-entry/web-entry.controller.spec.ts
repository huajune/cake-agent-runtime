jest.mock('fs', () => ({
  existsSync: jest.fn(),
}));

import { existsSync } from 'fs';
import { join } from 'path';
import { RootRedirectController, WebEntryController } from '@infra/server/web-entry/web-entry.controller';

function createResponse() {
  return {
    redirect: jest.fn().mockReturnThis(),
    sendFile: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
}

describe('RootRedirectController', () => {
  let controller: RootRedirectController;

  beforeEach(() => {
    controller = new RootRedirectController();
  });

  it('should redirect root requests to the web app entry', () => {
    const res = createResponse();

    const result = controller.redirectToWeb(res as never);

    expect(res.redirect).toHaveBeenCalledWith(302, '/web/');
    expect(result).toBe(res);
  });
});

describe('WebEntryController', () => {
  let controller: WebEntryController;
  let existsSyncMock: jest.MockedFunction<typeof existsSync>;

  beforeEach(() => {
    controller = new WebEntryController();
    existsSyncMock = existsSync as jest.MockedFunction<typeof existsSync>;
    existsSyncMock.mockReset();
  });

  it('should serve the requested static asset when it exists', () => {
    const req = { path: '/web/assets/index.js' };
    const res = createResponse();
    const assetPath = join(process.cwd(), 'public', 'web', 'assets/index.js');

    existsSyncMock.mockImplementation((path) => path === assetPath);

    const result = controller.serveWebApp(req as never, res as never);

    expect(res.sendFile).toHaveBeenCalledWith(assetPath);
    expect(result).toBe(res);
  });

  it('should fall back to index.html for SPA routes', () => {
    const req = { path: '/web/message-processing' };
    const res = createResponse();
    const indexPath = join(process.cwd(), 'public', 'web', 'index.html');

    existsSyncMock.mockImplementation((path) => path === indexPath);

    const result = controller.serveWebApp(req as never, res as never);

    expect(res.sendFile).toHaveBeenCalledWith(indexPath);
    expect(result).toBe(res);
  });

  it('should fall back to index.html when a static asset is missing', () => {
    const req = { path: '/web/assets/missing.js' };
    const res = createResponse();
    const indexPath = join(process.cwd(), 'public', 'web', 'index.html');

    existsSyncMock.mockImplementation((path) => path === indexPath);

    const result = controller.serveWebApp(req as never, res as never);

    expect(res.sendFile).toHaveBeenCalledWith(indexPath);
    expect(result).toBe(res);
  });

  it('should return a 404 page when the web build is missing', () => {
    const req = { path: '/web/' };
    const res = createResponse();

    existsSyncMock.mockReturnValue(false);

    const result = controller.serveWebApp(req as never, res as never);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining('Please run <code>pnpm run build:web</code>'),
    );
    expect(result).toBe(res);
  });
});
