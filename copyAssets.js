const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'src', 'config', 'firebase');
const destDir = path.join(__dirname, 'dist', 'config', 'firebase');

if (fs.existsSync(srcDir)) {
  fs.mkdirSync(destDir, { recursive: true });
  const files = fs.readdirSync(srcDir);
  for (const file of files) {
    fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
  }
  console.log('✅ Firebase configuration copied to dist directory');
} else {
  console.warn('⚠️ src/config/firebase directory not found, skipping asset copy.');
}

const assetsSrcDir = path.join(__dirname, 'src', 'assets');
const assetsDestDir = path.join(__dirname, 'dist', 'assets');

if (fs.existsSync(assetsSrcDir)) {
  fs.mkdirSync(assetsDestDir, { recursive: true });
  const files = fs.readdirSync(assetsSrcDir);
  for (const file of files) {
    fs.copyFileSync(path.join(assetsSrcDir, file), path.join(assetsDestDir, file));
  }
  console.log('✅ Assets copied to dist directory');
}

