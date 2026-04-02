import { Controller, Get, Head, Req, Res } from '@nestjs/common';
import { existsSync } from 'fs';
import { Request, Response } from 'express';
import { join } from 'path';
import { Public } from '@infra/server/response/decorators/api-response.decorator';

/**
 * Web 后台入口控制器
 *
 * 职责：
 * - 将根路径 `/` 重定向到 Web SPA 入口 `/web/`
 * - 托管 `public/web` 下构建后的前端静态资源
 */
@Public()
@Controller()
export class RootRedirectController {
  @Get()
  @Head()
  redirectToWeb(@Res() res: Response) {
    return res.redirect(302, '/web/');
  }
}

@Public()
@Controller('web')
export class WebEntryController {
  @Get('*')
  serveWebApp(@Req() req: Request, @Res() res: Response) {
    const relativePath = req.path.replace(/^\/web/, '');
    const publicWebPath = join(process.cwd(), 'public', 'web');

    if (relativePath.includes('.') && !relativePath.endsWith('.html')) {
      const filePath = join(publicWebPath, relativePath);
      if (existsSync(filePath)) {
        return res.sendFile(filePath);
      }
    }

    const indexPath = join(publicWebPath, 'index.html');
    if (existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }

    return res.status(404).send(`
      <h1>Web app not found</h1>
      <p>Please run <code>pnpm run build:web</code> to build the frontend.</p>
    `);
  }
}
