import { resolve } from 'node:path';
import { createDatabase } from './db.mjs';
import { createApp } from './app.mjs';

export async function startConsole(env = process.env) {
  const host = env.CONSOLE_HOST || '127.0.0.1';
  const port = Number(env.CONSOLE_PORT || 8770);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('CONSOLE_PORT must be between 0 and 65535');
  if (!env.DATABASE_URL && env.CONSOLE_EMBEDDED !== '1') throw new Error('Set DATABASE_URL, or set CONSOLE_EMBEDDED=1 for local development');
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost' && env.CONSOLE_TRUST_PRIVATE_BIND !== '1') throw new Error('Non-loopback binding requires CONSOLE_TRUST_PRIVATE_BIND=1 and a trusted TLS reverse proxy');
  const db = await createDatabase({connectionString:env.DATABASE_URL,dataDir:env.CONSOLE_DATA_DIR||'.data'});
  const server = await createApp({db,staticDir:resolve(import.meta.dirname,'../web')});
  server.on('close',()=>db.close().catch(error=>console.error('database shutdown failed',error.message)));
  await new Promise((accept,reject)=>{server.once('error',reject);server.listen(port,host,accept)});
  return server;
}
if(import.meta.url===`file://${process.argv[1]}`){
 startConsole().then(server=>{console.log(`Team console listening at http://${server.address().address}:${server.address().port}`);const stop=()=>server.close(error=>{if(error){console.error(error);process.exitCode=1}});process.once('SIGINT',stop);process.once('SIGTERM',stop)}).catch(error=>{console.error('Team console startup failed:',error.message);process.exitCode=1});
}
