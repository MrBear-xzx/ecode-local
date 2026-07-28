import * as assert from 'assert';
import { analyzeFormContexts } from '../../domain/formContextAnalyzer';

suite('Form context analyzer', () => {
  test('binds an A002-style runScript directory through shared pageInfo constants', () => {
    const root = '普为光电/流程表单/A-行政管理/A002-派车申请';
    const result = analyzeFormContexts([
      {
        path: '工具包/工具包管理/pageInfoConfig/ALC.js',
        content: `
          const carRequest = {
            WfFormId: -133,
          };
        `,
      },
      {
        path: `${root}/init.js`,
        content: `
          const { carRequest } = ecodeSDK.getCom('pageInfo', 'pageInfo');
          const runScript = () => WfForm.convertFieldNameToId('cfdd');
          ecodeSDK.overwritePropsFnQueueMapSet('WeaReqTop', {
            fn: () => {
              const { formid } = WfForm.getBaseInfo();
              if (formid !== carRequest.WfFormId) return;
              runScript();
            }
          });
        `,
      },
      {
        path: `${root}/components/HandlerMap.js`,
        content: 'export const HandlerMap = () => null;',
      },
    ]);

    assert.deepStrictEqual(
      result.bindingsByPath.get(`${root}/init.js`)?.map(item => [item.kind, item.id]),
      [['workflow', '-133']],
    );
    assert.deepStrictEqual(
      result.bindingsByPath.get(`${root}/components/HandlerMap.js`)
        ?.map(item => [item.kind, item.id]),
      [['workflow', '-133']],
    );
    assert.deepStrictEqual(result.warnings, []);
  });

  test('recognizes a ModeForm modeId guard and a literal alternative', () => {
    const root = '普为光电/建模表单/B-市场营销/内部订单';
    const result = analyzeFormContexts([
      {
        path: '工具包/pageInfoConfig/marketing.js',
        content: 'const internalOrder = { modeId: 153 };',
      },
      {
        path: `${root}/init.js`,
        content: `
          const runScript = () => ModeForm.convertFieldNameToId('wlxx');
          const { modeId } = ModeForm.getCardUrlInfo();
          if (modeId != internalOrder.modeId && modeId != 48) return;
          runScript();
        `,
      },
    ]);

    assert.deepStrictEqual(
      result.bindingsByPath.get(`${root}/init.js`)?.map(item => [item.kind, item.id]),
      [['mode', '153'], ['mode', '48']],
    );
  });

  test('distinguishes formid from a case-sensitive formId alias', () => {
    const root = '普为光电/流程表单/K-人事管理/K001-请假申请';
    const result = analyzeFormContexts([
      {
        path: '工具包/工具包管理/pageInfoConfig/HR.js',
        content: 'const goOfficialRequest = { WfFormId: -74 };',
      },
      {
        path: `${root}/register.js`,
        content: `
          const { goOfficialRequest } =
            ecodeSDK.getCom('pageInfo', 'pageInfo');
          let formId = goOfficialRequest.WfFormId;
          const { formid } = WfForm.getBaseInfo();
          if (formid !== formId) return;
        `,
      },
    ]);

    assert.deepStrictEqual(
      result.bindingsByPath.get(`${root}/register.js`)
        ?.map(item => [item.kind, item.id]),
      [['workflow', '-74']],
    );
    assert.deepStrictEqual(result.warnings, []);
    assert.strictEqual(result.unresolvedPaths.size, 0);
  });

  test('does not guess when the same shared symbol has conflicting values', () => {
    const root = '普为光电/流程表单/A-行政管理/冲突示例';
    const result = analyzeFormContexts([
      {
        path: 'shared/one.js',
        content: 'const formConfig = { WfFormId: -1 };',
      },
      {
        path: 'shared/two.js',
        content: 'const formConfig = { WfFormId: -2 };',
      },
      {
        path: `${root}/init.js`,
        content: `
          const { formid } = WfForm.getBaseInfo();
          if (formid !== formConfig.WfFormId) return;
        `,
      },
    ]);

    assert.strictEqual(result.bindingsByPath.has(`${root}/init.js`), false);
    assert.strictEqual(result.unresolvedPaths.has(`${root}/init.js`), true);
    assert.match(result.warnings[0], /存在多个候选值/);
  });

  test('ignores guards found only in comments and strings', () => {
    const result = analyzeFormContexts([
      {
        path: '普为光电/流程表单/A/示例/init.js',
        content: `
          // if (formid !== -133) return;
          const sample = "if (formid !== -133) return;";
        `,
      },
    ]);

    assert.strictEqual(result.bindingsByPath.size, 0);
  });
});
