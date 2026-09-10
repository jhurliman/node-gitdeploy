/// <reference types="node" />
import { Server } from 'node:http';
export interface Repository { url: string; path: string; ref: string; reset?: boolean; deploy?: string | string[] }
export interface Configuration {
  provider?: 'github' | 'gitlab' | 'gitlab-signed' | 'bitbucket';
  secret?: string; secretEnv?: string; repositories: Repository[];
  maxBodyBytes?: number; maxQueue?: number; commandTimeoutMs?: number;
  host?: string; web_port?: number;
}
export interface Receiver { server: Server; drain(): Promise<void>; close(): Promise<void> }
export function createServer(config: Configuration, options?: {
  deploy?: (repo: Repository, timeout: number) => void | Promise<void>;
  log?: (entry: { event: 'deployed' | 'failed'; repository: string }) => void;
}): Receiver;
export function deployRepository(repo: Repository, timeout: number): Promise<void>;
