import cluster from 'cluster';
import os from 'os';

const totalCPUs = os.cpus().length;

if (cluster.isPrimary) {
  console.log(`🚀 Master ${process.pid} is running`);
  console.log(`🚀 Starting ${totalCPUs} workers...`);
  
  // Fork workers
  for (let i = 0; i < totalCPUs; i++) {
    cluster.fork();
  }
  
  // Handle worker exit
  cluster.on('exit', (worker, code, signal) => {
    console.log(`❌ Worker ${worker.process.pid} died with code ${code} and signal ${signal}`);
    console.log('🔄 Starting a new worker...');
    cluster.fork();
  });
  
  // Handle worker online
  cluster.on('online', (worker) => {
    console.log(`✅ Worker ${worker.process.pid} is online`);
  });
  
} else {
  // Worker process - import your existing server.js
  console.log(`🔧 Worker ${process.pid} starting...`);
  
  // Import your existing server.js
  import('./server.js').then(() => {
    console.log(`✅ Worker ${process.pid} server started`);
  }).catch((error) => {
    console.error(`❌ Worker ${process.pid} failed to start:`, error);
    process.exit(1);
  });
}
