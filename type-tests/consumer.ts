import { createServer } from '..';
const receiver = createServer({ secret: 'test', repositories: [{ url: 'https://example.com/repo', path: '/srv/repo', ref: 'refs/heads/main' }] });
receiver.server.listen(0);
void receiver.drain();
void receiver.close();
// @ts-expect-error unsupported provider
createServer({provider:'other', repositories:[]});
