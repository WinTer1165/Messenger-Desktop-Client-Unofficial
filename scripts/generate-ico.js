#!/usr/bin/env node

/**
 * ICO Generation Script for Windows
 */

const { default: pngToIco } = require('png-to-ico');
const fs = require('fs');
const path = require('path');

const assetsDir = path.join(__dirname, '..', 'assets');

async function generateIco() {
  try {
    console.log('[ICO] Generating Windows icon file...');

    // Read the main PNG file
    const pngBuffer = fs.readFileSync(path.join(assetsDir, 'icon-256.png'));

    // Convert to ICO
    const icoBuffer = await pngToIco([pngBuffer]);
    fs.writeFileSync(path.join(assetsDir, 'icon.ico'), icoBuffer);

    console.log('[ICO] ✓ icon.ico generated successfully!');
  } catch (error) {
    console.error('[ICO] Error generating ICO:', error);
    process.exit(1);
  }
}

generateIco();
