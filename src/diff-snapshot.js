/*
 * Copyright (c) 2017 American Express Travel Related Services Company, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License. You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under the License
 * is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express
 * or implied. See the License for the specific language governing permissions and limitations under
 * the License.
 */

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const mkdirp = require('mkdirp');
const pixelmatch = require('pixelmatch');
const { PNG } = require('pngjs');
const rimraf = require('rimraf');

/**
 * Helper function to create reusable image resizer
 */
const createImageResizer = (width, height) => (source) => {
  const resized = new PNG({ width, height, fill: true });
  PNG.bitblt(source, resized, 0, 0, source.width, source.height, 0, 0);
  return resized;
};

/**
 * Fills diff area with black transparent color for meaningful diff
 */
/* eslint-disable no-plusplus, no-param-reassign, no-bitwise */
const fillSizeDifference = (width, height) => (image) => {
  const inArea = (x, y) => y > height || x > width;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (inArea(x, y)) {
        const idx = ((image.width * y) + x) << 2;
        image.data[idx] = 0;
        image.data[idx + 1] = 0;
        image.data[idx + 2] = 0;
        image.data[idx + 3] = 64;
      }
    }
  }
  return image;
};
/* eslint-enabled */

/**
 * Aligns images sizes to biggest common value
 * and fills new pixels with transparent pixels
 */
const alignImagesToSameSize = (firstImage, secondImage) => {
  // Keep original sizes to fill extended area later
  const firstImageWidth = firstImage.width;
  const firstImageHeight = firstImage.height;
  const secondImageWidth = secondImage.width;
  const secondImageHeight = secondImage.height;
  // Calculate biggest common values
  const resizeToSameSize = createImageResizer(
    Math.max(firstImageWidth, secondImageWidth),
    Math.max(firstImageHeight, secondImageHeight)
  );
  // Resize both images
  const resizedFirst = resizeToSameSize(firstImage);
  const resizedSecond = resizeToSameSize(secondImage);
  // Fill resized area with black transparent pixels
  return [
    fillSizeDifference(firstImageWidth, firstImageHeight)(resizedFirst),
    fillSizeDifference(secondImageWidth, secondImageHeight)(resizedSecond),
  ];
};

const isFailure = ({ pass, updateSnapshot }) => !pass && !updateSnapshot;

const shouldUpdate = ({ pass, updateSnapshot, updatePassedSnapshot }) => (
  (!pass && updateSnapshot) || (pass && updatePassedSnapshot)
);

function diffImageToSnapshot(options) {
  const {
    receivedImageBuffer,
    snapshotIdentifier,
    snapshotsDir,
    diffSnapshotsDir,
    updateSnapshot = false,
    updatePassedSnapshot = false,
    customDiffConfig = {},
    failureThreshold,
    failureThresholdType,
  } = options;

  let result = {};
  const baselineSnapshotPath = path.join(snapshotsDir, `${snapshotIdentifier}-snap.png`);
  if (!fs.existsSync(baselineSnapshotPath)) {
    mkdirp.sync(snapshotsDir);
    fs.writeFileSync(baselineSnapshotPath, receivedImageBuffer);
    result = { added: true };
  } else {
    const diffOutputPath = path.join(diffSnapshotsDir, `${snapshotIdentifier}-diff.png`);
    rimraf.sync(diffOutputPath);

    const defaultDiffConfig = {
      threshold: 0.01,
    };

    const diffConfig = Object.assign({}, defaultDiffConfig, customDiffConfig);

    const rawReceivedImage = PNG.sync.read(receivedImageBuffer);
    const rawBaselineImage = PNG.sync.read(fs.readFileSync(baselineSnapshotPath));
    const hasSizeMismatch = (
      rawReceivedImage.height !== rawBaselineImage.height ||
      rawReceivedImage.width !== rawBaselineImage.width
    );
    // Align images in size if different
    const [receivedImage, baselineImage] = hasSizeMismatch
      ? alignImagesToSameSize(rawReceivedImage, rawBaselineImage)
      : [rawReceivedImage, rawBaselineImage];
    const imageWidth = receivedImage.width;
    const imageHeight = receivedImage.height;
    const diffImage = new PNG({ width: imageWidth, height: imageHeight });

    const diffPixelCount = pixelmatch(
      receivedImage.data,
      baselineImage.data,
      diffImage.data,
      imageWidth,
      imageHeight,
      diffConfig
    );

    const totalPixels = imageWidth * imageHeight;
    const diffRatio = diffPixelCount / totalPixels;

    let pass = false;
    if (hasSizeMismatch) {
      // Always fail test on image size mismatch
      pass = false;
    } else if (failureThresholdType === 'pixel') {
      pass = diffPixelCount <= failureThreshold;
    } else if (failureThresholdType === 'percent') {
      pass = diffRatio <= failureThreshold;
    } else {
      throw new Error(`Unknown failureThresholdType: ${failureThresholdType}. Valid options are "pixel" or "percent".`);
    }

    if (isFailure({ pass, updateSnapshot })) {
      mkdirp.sync(diffSnapshotsDir);
      const compositeResultImage = new PNG({
        width: imageWidth * 3,
        height: imageHeight,
      });
      // copy baseline, diff, and received images into composite result image
      PNG.bitblt(
        baselineImage, compositeResultImage, 0, 0, imageWidth, imageHeight, 0, 0
      );
      PNG.bitblt(
        diffImage, compositeResultImage, 0, 0, imageWidth, imageHeight, imageWidth, 0
      );
      PNG.bitblt(
        receivedImage, compositeResultImage, 0, 0, imageWidth, imageHeight, imageWidth * 2, 0
      );
      // Set filter type to Paeth to avoid expensive auto scanline filter detection
      // For more information see https://www.w3.org/TR/PNG-Filters.html
      const pngBuffer = PNG.sync.write(compositeResultImage, { filterType: 4 });
      fs.writeFileSync(diffOutputPath, pngBuffer);

      result = {
        pass: false,
        diffOutputPath,
        diffRatio,
        diffPixelCount,
      };
    } else if (shouldUpdate({ pass, updateSnapshot, updatePassedSnapshot })) {
      mkdirp.sync(snapshotsDir);
      fs.writeFileSync(baselineSnapshotPath, receivedImageBuffer);
      result = { updated: true };
    } else {
      result = {
        pass,
        diffRatio,
        diffPixelCount,
        diffOutputPath,
      };
    }
  }
  return result;
}


function runDiffImageToSnapshot(options) {
  options.receivedImageBuffer = options.receivedImageBuffer.toString('base64');

  const serializedInput = JSON.stringify(options);

  let result = {};

  const writeDiffProcess = childProcess.spawnSync(
    'node', [`${__dirname}/diff-process.js`],
    { input: Buffer.from(serializedInput), stdio: ['pipe', 'inherit', 'inherit', 'pipe'] }
  );

  if (writeDiffProcess.status === 0) {
    const output = writeDiffProcess.output[3].toString();
    result = JSON.parse(output);
  } else {
    throw new Error('Error running image diff.');
  }

  return result;
}

module.exports = {
  diffImageToSnapshot,
  runDiffImageToSnapshot,
};
