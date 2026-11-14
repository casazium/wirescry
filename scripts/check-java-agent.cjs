// @ts-check
/** The packaged Java agent's check, for electron-builder.cjs (and test/packaging-java-agent.test.ts). */
const fs = require('node:fs');
const path = require('node:path');

/** The jars every installer ships (the attacher isn't shipped yet). */
const JAVA_AGENT_JARS = ['wirescry-agent.jar', 'wirescry-agent-impl.jar', 'wirescry-agent-weaver.jar'];

/**
 * The names of a zip's entries, from its central directory. Enough for the jars this build makes
 * (no zip64, no archive comment).
 *
 * @param {string} file
 */
function zipEntries(file) {
  const zip = fs.readFileSync(file);
  const end = zip.length - 22;
  if (end < 0 || zip.readUInt32LE(end) !== 0x06054b50)
    throw new Error(`${file} isn't a zip this check reads`);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`${file}: bad central directory`);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    names.push(zip.toString('utf8', at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

/**
 * Refuses a build without the Java agent's jars, or with native code in them (they run in any JVM).
 *
 * @param {string} dir
 */
function checkJavaAgent(dir) {
  for (const name of JAVA_AGENT_JARS) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      throw new Error(
        `No Java agent at ${file}. Build it with node scripts/build-java-agent.mjs (needs a JDK 17+).`,
      );
    }
    const native = zipEntries(file).filter((entry) => /\.(so|dylib|jnilib|dll)$/i.test(entry));
    if (native.length > 0) throw new Error(`${name} holds native libraries: ${native.join(', ')}`);
  }
}

module.exports = { JAVA_AGENT_JARS, zipEntries, checkJavaAgent };
