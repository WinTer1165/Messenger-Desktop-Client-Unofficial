const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const svgPath = path.join(__dirname, '..', 'assets', 'messenger-icon.svg');
const assetsDir = path.join(__dirname, '..', 'assets');

// Icon sizes to generate
const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];

async function generateIcons() {
  console.log('Generating Messenger icons...\n');

  const svgBuffer = fs.readFileSync(svgPath);

  // Generate PNG files at different sizes
  for (const size of sizes) {
    const outputPath = path.join(assetsDir, `icon-${size}.png`);
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(outputPath);
    console.log(`✓ Generated ${size}x${size} PNG: icon-${size}.png`);
  }

  // Generate main icon.png (512x512)
  const mainIconPath = path.join(assetsDir, 'icon.png');
  await sharp(svgBuffer)
    .resize(512, 512)
    .png()
    .toFile(mainIconPath);
  console.log(`✓ Generated main icon: icon.png (512x512)`);

  // Generate tray icon (smaller, 32x32)
  const trayIconPath = path.join(assetsDir, 'tray-icon.png');
  await sharp(svgBuffer)
    .resize(32, 32)
    .png()
    .toFile(trayIconPath);
  console.log(`✓ Generated tray icon: tray-icon.png (32x32)`);

  console.log('\n✅ All PNG icons generated successfully!');
  console.log('\nNow generating ICO file...');

  // For ICO generation, we need png-to-ico
  const { default: pngToIco } = await import('png-to-ico');

  // Generate ICO with multiple sizes (Windows requirement)
  const icoSizes = [16, 32, 48, 64, 128, 256];
  const icoBuffers = [];

  for (const size of icoSizes) {
    const buffer = await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toBuffer();
    icoBuffers.push(buffer);
  }

  const icoBuffer = await pngToIco(icoBuffers);
  const icoPath = path.join(assetsDir, 'icon.ico');
  fs.writeFileSync(icoPath, icoBuffer);

  console.log(`✓ Generated Windows ICO: icon.ico`);
  console.log('\n🎉 All icons generated successfully!');
}

generateIcons().catch(err => {
  console.error('Error generating icons:', err);
  process.exit(1);
});
