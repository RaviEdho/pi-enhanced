export const SYSTEMD_RESTART_EXIT: number;
export function gatewayPidRecord(pid: number, startedAt: string): { pid: number; startedAt: string; identity?: string };
export function readGatewayPid(path: string): number | undefined;
