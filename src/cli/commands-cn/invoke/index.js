'use strict';

const fs = require('fs');
const nodePath = require('path');
const utils = require('../utils');
const { isJson } = require('../../utils');
const { ServerlessSDK, utils: chinaUtils } = require('@serverless/platform-client-china');
const invokeLocal = require('./invoke-local');
const { generatePayload, storeLocally } = require('../telemtry');
const chalk = require('chalk');
const { inspect } = require('util');
const { v4: uuidv4 } = require('uuid');
const { runningTemplate } = require('../../utils');

/**
 * --stage / -s Set stage
 * --region / -r Set region
 * --data / -d Data sent to SCF
 * --path / -p Data path sent to SCF
 * --function / -f function alias
 * --namespace / -n SCF namespace
 * --qualifier / -q SCF qualifier
 */
module.exports = async (config, cli, command) => {
  const {
    stage,
    s,
    region,
    r,
    data,
    d,
    path,
    p,
    function: originalFunctionAlias,
    f,
    namespace,
    n,
    qualifier,
    q,
  } = config;
  const stageValue = stage || s;
  const regionValue = region || r;
  let dataValue = data || d;
  const pathValue = path || p;
  const functionAlias = originalFunctionAlias || f;
  const namespaceValue = namespace || n;
  const qualifierValue = qualifier || q;

  await utils.login(config);

  let instanceDir = process.cwd();
  if (config.target) {
    instanceDir = nodePath.join(instanceDir, config.target);
  }

  if (runningTemplate(instanceDir)) {
    try {
      instanceDir = await utils.getDirForInvokeCommand(instanceDir, functionAlias);
    } catch (e) {
      cli.log(`Serverless: ${chalk.yellow(e.message)}`);
      process.exit();
    }
  }

  await utils.checkBasicConfigValidation(instanceDir);

  const subCommand = config.params[0];

  if (subCommand === 'local') {
    return invokeLocal(config, cli, command, instanceDir);
  }

  const instanceYaml = await utils.loadInstanceConfig(instanceDir, command);
  const telemtryData = await generatePayload({ command, rootConfig: instanceYaml });

  try {
    if (dataValue && pathValue) {
      cli.log(`Serverless: ${chalk.yellow('?????????????????? data ??? path, ??????????????????')}`);

      await storeLocally({
        ...telemtryData,
        outcome: 'failure',
        failure_reason: '?????????????????? data ??? path, ??????????????????',
      });
      process.exit();
    }

    if (path || p) {
      try {
        dataValue = fs.readFileSync(pathValue, 'utf8');
      } catch (e) {
        cli.log(`Serverless: ${chalk.yellow('??????????????????????????????, ??????????????????')}`);

        await storeLocally({
          ...telemtryData,
          outcome: 'failure',
          failure_reason: '??????????????????????????????, ??????????????????',
        });
        process.exit();
      }
    }

    if (dataValue && !isJson(dataValue)) {
      cli.log(`Serverless: ${chalk.yellow('????????? data ??????????????? JSON, ??????????????????')}`);

      await storeLocally({
        ...telemtryData,
        outcome: 'failure',
        failure_reason: '????????? data ??????????????? JSON, ??????????????????',
      });
      process.exit();
    }

    const componentType = instanceYaml && instanceYaml.component;

    const orgUid = await chinaUtils.getOrgId();
    telemtryData.user_uid = orgUid;

    if (!componentType.startsWith('scf') && !componentType.startsWith('multi-scf')) {
      cli.log(`Serverless: ${chalk.yellow('Inovke ??????????????? scf ?????? multi-scf ?????????????????????')}`);

      await storeLocally({
        ...telemtryData,
        outcome: 'failure',
        failure_reason: 'Inovke ??????????????? scf ?????? multi-scf ?????????????????????',
      });
      process.exit();
    }

    const sdk = new ServerlessSDK({
      context: {
        orgName: instanceYaml.org,
        traceId: uuidv4(),
        orgUid,
      },
    });

    const options = {
      functionAlias,
      stage: stageValue,
      region: regionValue,
      event: JSON.parse(dataValue || '{}'),
      namespace: namespaceValue,
      qualifier: qualifierValue,
    };
    let res;
    try {
      res = await sdk.invoke(
        instanceYaml.org,
        instanceYaml.app,
        instanceYaml.stage,
        instanceYaml.name,
        options
      );
    } catch (e) {
      if (!e.extraErrorInfo) {
        e.extraErrorInfo = {
          step: '??????????????????',
        };
      } else {
        e.extraErrorInfo.step = '??????????????????';
      }

      throw e;
    }

    if (res.retMsg) {
      const retMsg = res.retMsg;
      delete res.retMsg;
      cli.logOutputs(res);
      cli.log('---------------------------------------------');
      cli.log(`Serverless: ${chalk.green('????????????')}`);
      cli.log();
      try {
        const retJson = JSON.parse(retMsg);
        cli.log(inspect(retJson, { depth: Infinity, colors: true, compact: 0 }));
      } catch (error) {
        cli.log(retMsg);
      }
    } else {
      cli.logOutputs(res);
    }

    await storeLocally({
      ...telemtryData,
      outcome: 'success',
    });
    return 0;
  } catch (e) {
    telemtryData.outcome = 'failure';
    telemtryData.failure_reason = e.message;
    await storeLocally(telemtryData, e);

    throw e;
  }
};
