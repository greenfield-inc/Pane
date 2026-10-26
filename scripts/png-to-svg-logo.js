#!/usr/bin/env node
/**
 * Convert a PNG logo to SVG using potrace bitmap tracing.
 * Generates both dark-mode and light-mode variants.
 *
 * Usage: node scripts/png-to-svg-logo.js <input.png>
 *
 * Outputs:
 *   Dark mode (white P on black bg):
 *     - frontend/src/assets/pane-logo-dark.svg
 *     - frontend/public/pane-logo-dark.svg
 *     - main/assets/pane-logo-dark.svg
 *   Light mode (black P on white bg):
 *     - frontend/src/assets/pane-logo-light.svg
 *     - frontend/public/pane-logo-light.svg
 *     - main/assets/pane-logo-light.svg
 *   Default (dark mode, for backward compat):
 *     - frontend/src/assets/pane-logo.svg
 *     - frontend/public/pane-logo.svg
 *     - main/assets/pane-logo.svg
 */

const fs = require('fs');
const path = require('path');

const inputPng = process.argv[2];
if (!inputPng) {
  console.error('Usage: node scripts/png-to-svg-logo.js <input.png>');
  process.exit(1);
}

const inputPath = path.resolve(inputPng);
if (!fs.existsSync(inputPath)) {
  console.error(`File not found: ${inputPath}`);
  process.exit(1);
}

const projectRoot = path.resolve(__dirname, '..');

const logoDirs = [
  'frontend/src/assets',
  'frontend/public',
  'main/assets',
];

async function traceSvgPath(potrace, imagePath) {
  const svgContent = await new Promise((resolve, reject) => {
    potrace.trace(imagePath, {
      threshold: 128,
      turdSize: 5,
      optTolerance: 0.2,
      color: '#000000',
      background: 'transparent',
    }, (err, svg) => {
      if (err) reject(err);
      else resolve(svg);
    });
  });

  const pathMatch = svgContent.match(/<path[^>]*d="([^"]+)"[^>]*\/>/);
  if (!pathMatch) {
    throw new Error('Failed to extract path from traced SVG');
  }
  return pathMatch[1];
}

function buildSvg(pathData, fgColor, bgColor, comment) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <!-- Pane logo: ${comment} (traced from PNG) -->
  <rect x="0" y="0" width="512" height="512" rx="100" fill="${bgColor}"/>
  <path d="${pathData}" fill="${fgColor}" fill-rule="evenodd"/>
</svg>
`;
}

async function main() {
  const potrace = require('potrace');
  const sharp = require('sharp');

  console.log(`Processing ${inputPath}...`);
  const preprocessed = path.join(projectRoot, '_logo_preprocessed.png');

  // Negate the image: the input has white P on black bg.
  // Potrace traces dark regions, so we negate to make the P dark (traceable).
  await sharp(inputPath)
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 1 } })
    .grayscale()
    .normalize()
    .negate()
    .png()
    .toFile(preprocessed);

  console.log('Tracing bitmap to SVG...');
  const pathData = await traceSvgPath(potrace, preprocessed);

  fs.unlinkSync(preprocessed);

  // Dark mode: white P on black background
  const darkSvg = buildSvg(pathData, '#ffffff', '#000000', 'P. dark mode - white on black');
  // Light mode: black P on white background
  const lightSvg = buildSvg(pathData, '#000000', '#ffffff', 'P. light mode - black on white');

  for (const dir of logoDirs) {
    const absDir = path.join(projectRoot, dir);

    // Dark mode variant
    const darkPath = path.join(absDir, 'pane-logo-dark.svg');
    fs.writeFileSync(darkPath, darkSvg);
    console.log(`  Written: ${darkPath}`);

    // Light mode variant
    const lightPath = path.join(absDir, 'pane-logo-light.svg');
    fs.writeFileSync(lightPath, lightSvg);
    console.log(`  Written: ${lightPath}`);

    // Default (dark mode for backward compat)
    const defaultPath = path.join(absDir, 'pane-logo.svg');
    fs.writeFileSync(defaultPath, darkSvg);
    console.log(`  Written: ${defaultPath}`);
  }

  console.log('\nDone! Generated dark + light logos in all 3 locations.');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
