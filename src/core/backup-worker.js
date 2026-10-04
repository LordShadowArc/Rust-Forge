const path = require('path');
const { parentPort, workerData } = require('worker_threads');
const AdmZip = require('adm-zip');
const fs = require('fs');

try {
  const zip = new AdmZip();
  const source = workerData.source;
  zip.addLocalFolder(source, `server/${workerData.identity}`);
  const metadata = JSON.stringify({ application:'Rust Forge', backupVersion:1, createdAt:Date.now(), server:workerData.name, identity:workerData.identity }, null, 2);
  zip.addFile('rust-forge-backup.json', Buffer.from(metadata,'utf8'));
  zip.writeZip(workerData.output);
  parentPort.postMessage({type:'done'});
} catch (error) {
  parentPort.postMessage({type:'error',error:error.message}); process.exitCode=1;
}
