import { playWsService } from '../services/play-ws.service'

/** WebSocket handlers for `/ws/play`; delegate to {@link playWsService}. */
export const playWsController = {
  open: (ws: Parameters<typeof playWsService.handleOpen>[0]) => playWsService.handleOpen(ws),

  message: (ws: Parameters<typeof playWsService.handleMessage>[0], msg: unknown) =>
    playWsService.handleMessage(ws, msg),

  close: (ws: Parameters<typeof playWsService.handleClose>[0]) => playWsService.handleClose(ws),
}
