/**
 * @license Copyright 2016 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const log = require('lighthouse-logger');
const stream = require('stream');
const Simulator = require('./dependency-graph/simulator/simulator.js');
const lanternTraceSaver = require('./lantern-trace-saver.js');
const Metrics = require('./traces/pwmetrics-events.js');
const rimraf = require('rimraf');
const mkdirp = require('mkdirp');
const NetworkAnalysisComputed = require('../computed/network-analysis.js');
const LoadSimulatorComputed = require('../computed/load-simulator.js');

const artifactsFilename = 'artifacts.json';
const traceSuffix = '.trace.json';
const devtoolsLogSuffix = '.devtoolslog.json';

/**
 * @typedef {object} PreparedAssets
 * @property {string} passName
 * @property {LH.Trace} traceData
 * @property {LH.DevtoolsLog} devtoolsLog
 */


/**
 * Load artifacts object from files located within basePath
 * Also save the traces to their own files
 * @param {string} basePath
 * @return {Promise<LH.Artifacts>}
 */
async function loadArtifacts(basePath) {
  log.log('Reading artifacts from disk:', basePath);

  if (!fs.existsSync(basePath)) {
    throw new Error('No saved artifacts found at ' + basePath);
  }

  // load artifacts.json
  /** @type {LH.Artifacts} */
  const artifacts = JSON.parse(fs.readFileSync(path.join(basePath, artifactsFilename), 'utf8'));

  const filenames = fs.readdirSync(basePath);

  // load devtoolsLogs
  artifacts.devtoolsLogs = {};
  filenames.filter(f => f.endsWith(devtoolsLogSuffix)).forEach(filename => {
    const passName = filename.replace(devtoolsLogSuffix, '');
    const devtoolsLog = JSON.parse(fs.readFileSync(path.join(basePath, filename), 'utf8'));
    artifacts.devtoolsLogs[passName] = devtoolsLog;
  });

  // load traces
  artifacts.traces = {};
  filenames.filter(f => f.endsWith(traceSuffix)).forEach(filename => {
    const file = fs.readFileSync(path.join(basePath, filename), {encoding: 'utf-8'});
    const trace = JSON.parse(file);
    const passName = filename.replace(traceSuffix, '');
    artifacts.traces[passName] = Array.isArray(trace) ? {traceEvents: trace} : trace;
  });

  if (Array.isArray(artifacts.Timing)) {
    // Any Timing entries in saved artifacts will have a different timeOrigin than the auditing phase
    // The `gather` prop is read later in generate-timing-trace and they're added to a separate track of trace events
    artifacts.Timing.forEach(entry => (entry.gather = true));
  }
  return artifacts;
}

/**
 * Save artifacts object mostly to single file located at basePath/artifacts.log.
 * Also save the traces & devtoolsLogs to their own files
 * @param {LH.Artifacts} artifacts
 * @param {string} basePath
 * @return {Promise<void>}
 */
async function saveArtifacts(artifacts, basePath) {
  const status = {msg: 'Saving artifacts', id: 'lh:assetSaver:saveArtifacts'};
  log.time(status);
  mkdirp.sync(basePath);
  rimraf.sync(`${basePath}/*${traceSuffix}`);
  rimraf.sync(`${basePath}/${artifactsFilename}`);

  const {traces, devtoolsLogs, ...restArtifacts} = artifacts;

  // save traces
  for (const [passName, trace] of Object.entries(traces)) {
    await saveTrace(trace, `${basePath}/${passName}${traceSuffix}`);
  }

  // save devtools log
  for (const [passName, devtoolsLog] of Object.entries(devtoolsLogs)) {
    const log = JSON.stringify(devtoolsLog);
    fs.writeFileSync(`${basePath}/${passName}${devtoolsLogSuffix}`, log, 'utf8');
  }

  // save everything else
  const restArtifactsString = JSON.stringify(restArtifacts, null, 2);
  fs.writeFileSync(`${basePath}/${artifactsFilename}`, restArtifactsString, 'utf8');
  log.log('Artifacts saved to disk in folder:', basePath);
  log.timeEnd(status);
}

/**
 * Filter traces and extract screenshots to prepare for saving.
 * @param {LH.Artifacts} artifacts
 * @param {LH.Audit.Results} [audits]
 * @return {Promise<Array<PreparedAssets>>}
 */
async function prepareAssets(artifacts, audits) {
  const passNames = Object.keys(artifacts.traces);
  /** @type {Array<PreparedAssets>} */
  const assets = [];

  for (const passName of passNames) {
    const trace = artifacts.traces[passName];
    const devtoolsLog = artifacts.devtoolsLogs[passName];

    const traceData = Object.assign({}, trace);
    if (audits) {
      const evts = new Metrics(traceData.traceEvents, audits).generateFakeEvents();
      traceData.traceEvents = traceData.traceEvents.concat(evts);
    }

    assets.push({
      passName,
      traceData,
      devtoolsLog,
    });
  }

  return assets;
}

/**
 * Generates a JSON representation of traceData line-by-line for a nicer printed
 * version with one trace event per line.
 * @param {LH.Trace} traceData
 * @return {IterableIterator<string>}
 */
function* traceJsonGenerator(traceData) {
  const EVENTS_PER_ITERATION = 500;
  const keys = Object.keys(traceData);

  yield '{\n';

  // Stringify and emit trace events separately to avoid a giant string in memory.
  yield '"traceEvents": [\n';
  if (traceData.traceEvents.length > 0) {
    const eventsIterator = traceData.traceEvents[Symbol.iterator]();
    // Emit first item manually to avoid a trailing comma.
    const firstEvent = eventsIterator.next().value;
    yield `  ${JSON.stringify(firstEvent)}`;

    let eventsRemaining = EVENTS_PER_ITERATION;
    let eventsJSON = '';
    for (const event of eventsIterator) {
      eventsJSON += `,\n  ${JSON.stringify(event)}`;
      eventsRemaining--;
      if (eventsRemaining === 0) {
        yield eventsJSON;
        eventsRemaining = EVENTS_PER_ITERATION;
        eventsJSON = '';
      }
    }
    yield eventsJSON;
  }
  yield '\n]';

  // Emit the rest of the object (usually just `metadata`)
  if (keys.length > 1) {
    for (const key of keys) {
      if (key === 'traceEvents') continue;

      yield `,\n"${key}": ${JSON.stringify(traceData[key], null, 2)}`;
    }
  }

  yield '}\n';
}

/**
 * Save a trace as JSON by streaming to disk at traceFilename.
 * @param {LH.Trace} traceData
 * @param {string} traceFilename
 * @return {Promise<void>}
 */
function saveTrace(traceData, traceFilename) {
  return new Promise((resolve, reject) => {
    const traceIter = traceJsonGenerator(traceData);
    // A stream that pulls in the next traceJsonGenerator chunk as writeStream
    // reads from it. Closes stream with null when iteration is complete.
    const traceStream = new stream.Readable({
      read() {
        const next = traceIter.next();
        this.push(next.done ? null : next.value);
      },
    });

    const writeStream = fs.createWriteStream(traceFilename);
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);

    traceStream.pipe(writeStream);
  });
}

/**
 * @param {string} pathWithBasename
 * @return {Promise<void>}
 */
async function saveLanternDebugTraces(pathWithBasename) {
  if (!process.env.LANTERN_DEBUG) return;

  for (const [label, nodeTimings] of Simulator.ALL_NODE_TIMINGS) {
    if (lanternTraceSaver.simulationNamesToIgnore.includes(label)) continue;

    const traceFilename = `${pathWithBasename}-${label}${traceSuffix}`;
    await saveTrace(lanternTraceSaver.convertNodeTimingsToTrace(nodeTimings), traceFilename);
    log.log('saveAssets', `${label} lantern trace file streamed to disk: ${traceFilename}`);
  }
}

/**
 * Writes trace(s) and associated asset(s) to disk.
 * @param {LH.Artifacts} artifacts
 * @param {LH.Audit.Results} audits
 * @param {string} pathWithBasename
 * @return {Promise<void>}
 */
async function saveAssets(artifacts, audits, pathWithBasename) {
  const allAssets = await prepareAssets(artifacts, audits);
  const saveAll = allAssets.map(async (passAssets, index) => {
    const devtoolsLogFilename = `${pathWithBasename}-${index}${devtoolsLogSuffix}`;
    fs.writeFileSync(devtoolsLogFilename, JSON.stringify(passAssets.devtoolsLog, null, 2));
    log.log('saveAssets', 'devtools log saved to disk: ' + devtoolsLogFilename);

    const streamTraceFilename = `${pathWithBasename}-${index}${traceSuffix}`;
    log.log('saveAssets', 'streaming trace file to disk: ' + streamTraceFilename);
    await saveTrace(passAssets.traceData, streamTraceFilename);
    log.log('saveAssets', 'trace file streamed to disk: ' + streamTraceFilename);
  });

  await Promise.all(saveAll);
  await saveLanternDebugTraces(pathWithBasename);
}

/**
 * Log trace(s) and associated devtoolsLog(s) to console.
 * @param {LH.Artifacts} artifacts
 * @param {LH.Audit.Results} audits
 * @return {Promise<Array<{name: string, contents: string}>>}
 */
async function prepareAssetsForLogging(artifacts, audits) {
  /** @type {Array<{name: string, contents: string}>} */
  const assetsToLog = [];

  const allAssets = await prepareAssets(artifacts, audits);
  allAssets.map(passAssets => {
    assetsToLog.push({
      name: `devtoolslog-${passAssets.passName}.json`,
      contents: JSON.stringify(passAssets.devtoolsLog),
    });
    const traceIter = traceJsonGenerator(passAssets.traceData);
    const traceJson = [...traceIter].join();
    assetsToLog.push({
      name: `trace-${passAssets.passName}.json`,
      contents: traceJson,
    });
  });

  return assetsToLog;
}


/**
 * Log trace(s) and associated devtoolsLog(s) to console.
 * @param {Array<{name: string, contents: string}>} assetsToLog
 */
function logAssets(assetsToLog) {
  for (const asset of assetsToLog) {
    // eslint-disable-next-line no-console
    console.log(`loggedAsset %%% ${asset.name} %%% ${asset.contents}`);
  }
}

/**
 * @param {LH.DevtoolsLog} devtoolsLog
 * @param {string} outputPath
 * @return {Promise<void>}
 */
async function saveLanternNetworkData(devtoolsLog, outputPath) {
  const context = /** @type {LH.Audit.Context} */ ({computedCache: new Map()});
  const networkAnalysis = await NetworkAnalysisComputed.request(devtoolsLog, context);
  const lanternData = LoadSimulatorComputed.convertAnalysisToSaveableLanternData(networkAnalysis);

  fs.writeFileSync(outputPath, JSON.stringify(lanternData));
}

module.exports = {
  saveArtifacts,
  loadArtifacts,
  saveAssets,
  prepareAssets,
  prepareAssetsForLogging,
  saveTrace,
  logAssets,
  saveLanternNetworkData,
};
