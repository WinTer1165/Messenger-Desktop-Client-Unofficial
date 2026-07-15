#!/usr/bin/env node

/**
 * Icon Generation Script
 *
 * Generates PNG and ICO files from the SVG icon
 */

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const assetsDir = path.join(__dirname, '..', 'assets');
const svgPath = path.join(assetsDir, 'icon.svg');

async function generateIcons() {
  try {
    console.log('[Icons] Reading SVG...');
    const svgBuffer = fs.readFileSync(svgPath);

    // Generate main PNG icon (512x512)
    console.log('[Icons] Generating icon.png (512x512)...');
    await sharp(svgBuffer)
      .resize(512, 512)
      .png()
      .toFile(path.join(assetsDir, 'icon.png'));

    // Generate tray icon (32x32)
    console.log('[Icons] Generating tray-icon.png (32x32)...');
    await sharp(svgBuffer)
      .resize(32, 32)
      .png()
      .toFile(path.join(assetsDir, 'tray-icon.png'));

    // Generate various sizes for ICO
    console.log('[Icons] Generating ICO component PNGs...');
    const icoSizes = [16, 32, 48, 64, 128, 256];
    const icoBuffers = [];

    for (const size of icoSizes) {
      const buffer = await sharp(svgBuffer)
        .resize(size, size)
        .png()
        .toBuffer();
      icoBuffers.push(buffer);

      // Also save individual sizes for reference
      await sharp(buffer)
        .toFile(path.join(assetsDir, `icon-${size}.png`));
    }

    console.log('[Icons] ✓ Icon generation complete!');
    console.log('[Icons] Generated files:');
    console.log('  - icon.png (512x512)');
    console.log('  - tray-icon.png (32x32)');
    icoSizes.forEach(size => {
      console.log(`  - icon-${size}.png (${size}x${size})`);
    });

    console.log('\n[Icons] Note: For ICO and ICNS generation, you may need additional tools:');
    console.log('  - Windows ICO: Use png-to-ico or ImageMagick');
    console.log('  - macOS ICNS: Use iconutil on macOS');

  } catch (error) {
    console.error('[Icons] Error generating icons:', error);
    process.exit(1);
  }
}

generateIcons();
