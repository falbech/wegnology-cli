const paginateRequest = require('./paginate-request');
const inquirer = require('inquirer');
const {
  loadConfig,
  getShallowStatus,
  logResult,
  logProcessing,
  logError,
  mapById,
  plural
} = require('./utils');
const {
  remove,
  writeFile,
  ensureDir
} = require('fs-extra');
const { values, isEmpty } = require('omnibelt');
const allSettledSerial = require('./all-settled-serial-p');
const { rollbarLog } = require('./rollbar');
const sanitize = require('sanitize-filename');

const getExporter = ({
  apiType, commandType, localStatusParams, remoteStatusParams, getData
}) => {
  const exporter = async (pattern, command = {}, loadedConfig) => {
    let didExport = false;
    const { apiToken, applicationId, api } = loadedConfig ? loadedConfig : await loadConfig();
    if (!apiToken || !applicationId) { return; }
    await ensureDir(commandType);
    let items;
    try {
      items = await paginateRequest(api[apiType].get, { applicationId });
      items.forEach((item) => {
        item.name = sanitize(item.name);
      });
    } catch (e) {
      return logError(e);
    }
    const itemsById = mapById(items);
    const { remoteStatusByFile, localStatusByFile } = await getShallowStatus({
      items,
      remoteStatusParams,
      localStatusParams,
      dir: commandType,
      pattern
    });
    if (command.dryRun) {
      logResult('DRY RUN');
    }
    if (isEmpty(remoteStatusByFile)) {
      if (!pattern) {
        return logResult('Missing', `No ${plural(commandType)} found to export.`, 'yellow');
      } else {
        return logResult('No Matches', `No ${plural(commandType)} found that match this pattern ${pattern}`, 'yellow');
      }
    }
    const downloadResults = await allSettledSerial(async (remoteStatus) => {
      logProcessing(remoteStatus.file);
      if (!command.force) {
        const conflict = localStatusByFile.has(remoteStatus.file) && remoteStatus.status === 'found';
        if (conflict) {
          const { handleConflict } = await inquirer.prompt([{
            name: 'handleConflict',
            type: 'confirm',
            message: `The file ${remoteStatus.file} already exists, do you want to overwrite it?`
          }]);
          if (!handleConflict) {
            return logResult('skipped', remoteStatus.file, 'yellow');
          }
        }
      }
      if (remoteStatus.status === 'missing' && !command.dryRun) {
        const { canDelete } = await inquirer.prompt([{
          name: 'canDelete',
          type: 'confirm',
          message: `The file ${remoteStatus.file} is missing remotely, do you want to delete it locally?`
        }]);
        if (canDelete) {
          try {
            await remove(remoteStatus.file);
          } catch (e) {
            return logError(`An Error occurred when trying to delete file ${remoteStatus.file} with the message ${e.message}`);
          }
          return logResult('deleted', remoteStatus.file, 'yellow');
        } else {
          return logResult('unmodified', remoteStatus.file);
        }
      }
      if (!command.dryRun) {
        let data;
        try {
          data = await getData(itemsById[remoteStatus.id], api);
        } catch (e) {
          return logError(`An Error occurred when trying to export data for file ${remoteStatus.file} with the message ${e.message}`);
        }
        try {
          await writeFile(remoteStatus.file, data);
        } catch (e) {
          return logError(`An Error occurred when trying to write the file ${remoteStatus.file} with the message ${e.message}`);
        }
      }
      logResult('exported', remoteStatus.file, 'green');
      didExport = true;
    }, values(remoteStatusByFile));
    downloadResults.forEach((result) => {
      // this should only occur on unhandled rejections any api error should have already logged and resolved the promise
      if (result.state !== 'fulfilled') {
        rollbarLog(result.reason);
        logError(result.reason);
      }
    });
    return didExport;
  };
  return exporter;
};

module.exports = getExporter;