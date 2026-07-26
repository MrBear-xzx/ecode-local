import * as assert from 'assert';
import {
  findDirectComponentReferenceAt,
  getComponentBindings,
  getComponentEntries,
  getComponentEntry,
  parseComponentMemberContext,
  parseJsxComponentCompletionContext,
  parseJsxPropContext,
} from '../../language/componentKnowledge';
import {
  findEcodeComponentCallAt,
  parseEcodeComponentCalls,
  parseEcodeComponentNameCompletionContext,
} from '../../language/componentRegistry';
import {
  findApiObjectReferenceAt,
  findApiReferenceAt,
  getApiEntries,
  getApiEntry,
  getApiObjectInfo,
  parseCallContext,
  parseCompletionContext,
} from '../../language/knowledge';
import {
  getApiParameterSchema,
  getComponentPropSchema,
  parseApiNestedPropertyContext,
  parseComponentNestedPropertyContext,
  parseNestedPropertyContext,
} from '../../language/nestedKnowledge';

suite('Ecode API knowledge', () => {
  test('covers SDK, workflow, modeling card, and modeling list globals', () => {
    assert.ok(getApiEntries('ecodeSDK').length >= 20);
    assert.ok(getApiEntries('WfForm').length >= 50);
    assert.ok(getApiEntries('ModeForm').length >= 45);
    assert.ok(getApiEntries('ModeList').length >= 15);
  });

  test('parses member completion context with optional window prefix', () => {
    assert.deepStrictEqual(parseCompletionContext('WfForm.getF'), {
      object: 'WfForm',
      prefix: 'getF',
    });
    assert.deepStrictEqual(parseCompletionContext('window.ModeForm.'), {
      object: 'ModeForm',
      prefix: '',
    });
    assert.strictEqual(parseCompletionContext('other.getF'), undefined);
  });

  test('finds known API references without matching unrelated methods', () => {
    const source = 'const value = WfForm.getFieldValue("field110");';
    const offset = source.indexOf('getFieldValue') + 4;
    assert.strictEqual(findApiReferenceAt(source, offset)?.name, 'getFieldValue');
    assert.strictEqual(findApiReferenceAt('other.getFieldValue()', 10), undefined);
  });

  test('finds API object references independently from their members', () => {
    const source = 'const value = window.WfForm.convertFieldNameToId("name");';
    assert.strictEqual(
      findApiObjectReferenceAt(source, source.indexOf('WfForm') + 2)?.object,
      'WfForm',
    );
    assert.strictEqual(
      findApiObjectReferenceAt(
        source,
        source.indexOf('convertFieldNameToId') + 2,
      ),
      undefined,
    );
    assert.match(getApiObjectInfo('WfForm')?.description ?? '', /流程表单/);
  });

  test('tracks the active parameter for signature help', () => {
    const first = parseCallContext('WfForm.changeFieldValue(');
    const second = parseCallContext('WfForm.changeFieldValue("field110", ');
    assert.strictEqual(first?.activeParameter, 0);
    assert.strictEqual(second?.activeParameter, 1);
    assert.strictEqual(second?.entry, getApiEntry('WfForm', 'changeFieldValue'));
    assert.strictEqual(second?.activeArgumentText.trim(), '');

    const nestedObject = parseCallContext(
      'WfForm.changeFieldValue("field110", '
      + '{ value: "2,3", specialobj: [{ id: "2", name: "张三" }] }',
    );
    assert.strictEqual(nestedObject?.activeParameter, 1);
  });

  test('provides required, type, and description metadata for every parameter', () => {
    for (const entry of getApiEntries()) {
      for (const parameter of entry.parameters) {
        assert.ok(parameter.name);
        assert.ok(parameter.type);
        assert.ok(parameter.description);
        assert.ok(!parameter.description.includes('请以官方在线文档为准'));
      }
    }

    const changeFieldValue = getApiEntry('WfForm', 'changeFieldValue');
    assert.deepStrictEqual(
      changeFieldValue?.parameters.map(parameter => ({
        name: parameter.name,
        required: parameter.required,
      })),
      [
        { name: 'fieldMark', required: true },
        { name: 'valueInfo', required: true },
      ],
    );
    assert.ok(changeFieldValue?.parameters[1].description.includes('specialobj'));
  });

  test('matches corrected multi-parameter signatures from official docs', () => {
    assert.deepStrictEqual(
      getApiEntry('WfForm', 'changeMoreField')?.parameters.map(parameter => parameter.name),
      ['changeDatas', 'changeVariable'],
    );
    assert.deepStrictEqual(
      getApiEntry('ModeForm', 'doCardSubmit')?.parameters.map(parameter => parameter.name),
      ['pageExpandId', 'isSystemFlag', 'buttonType', 'refreshTo', 'callback'],
    );
    assert.deepStrictEqual(
      getApiEntry('ModeList', 'slideOpenModal')?.parameters.map(parameter => parameter.name),
      ['visible', 'url', 'percent'],
    );
  });
});

suite('Ecode component registry knowledge', () => {
  test('parses static setCom and getCom calls while ignoring comments and strings', () => {
    const source = [
      '// ecodeSDK.setCom("ignored", "Commented", Value);',
      'const example = "ecodeSDK.getCom(\\"ignored\\", \\"StringValue\\")";',
      'window.ecodeSDK.setCom(',
      '  "app-demo",',
      '  "SharedWidget",',
      '  SharedWidget,',
      ');',
      'const Widget = ecodeSDK.getCom("app-demo", "SharedWidget");',
      'ecodeSDK.getCom(dynamicAppId, "DynamicWidget");',
    ].join('\n');
    const calls = parseEcodeComponentCalls(source);
    assert.deepStrictEqual(
      calls.map(call => ({
        method: call.method,
        appId: call.appId,
        name: call.name,
      })),
      [
        { method: 'setCom', appId: 'app-demo', name: 'SharedWidget' },
        { method: 'getCom', appId: 'app-demo', name: 'SharedWidget' },
      ],
    );
    const referenceOffset = source.lastIndexOf('SharedWidget') + 3;
    const reference = findEcodeComponentCallAt(source, referenceOffset);
    assert.strictEqual(reference?.kind, 'reference');
    assert.strictEqual(
      source.slice(reference?.nameRange.start, reference?.nameRange.end),
      'SharedWidget',
    );
  });

  test('recognizes component-name completion inside and before string literals', () => {
    assert.deepStrictEqual(
      parseEcodeComponentNameCompletionContext(
        'ecodeSDK.getCom("app-demo", "Sha',
      ),
      {
        method: 'getCom',
        appId: 'app-demo',
        prefix: 'Sha',
        replaceLength: 3,
        hasOpeningQuote: true,
        quote: '"',
      },
    );
    assert.deepStrictEqual(
      parseEcodeComponentNameCompletionContext(
        'window.ecodeSDK.setCom(\'app-demo\', ',
      ),
      {
        method: 'setCom',
        appId: 'app-demo',
        prefix: '',
        replaceLength: 0,
        hasOpeningQuote: false,
        quote: undefined,
      },
    );
    assert.strictEqual(
      parseEcodeComponentNameCompletionContext(
        'ecodeSDK.getCom(dynamicAppId, "Sha',
      ),
      undefined,
    );
  });
});

suite('Ecode PC component knowledge', () => {
  test('covers the official ecCom and bundled antd catalog', () => {
    assert.strictEqual(getComponentEntries('ecCom').length, 90);
    assert.strictEqual(getComponentEntries('antd').length, 37);
    assert.ok(getComponentEntries().reduce(
      (count, entry) => count + entry.props.length,
      0,
    ) >= 1900);
  });

  test('provides type and description metadata for every documented prop', () => {
    for (const entry of getComponentEntries()) {
      for (const prop of entry.props) {
        assert.match(prop.name, /^[A-Za-z_$][\w$]*$/);
        assert.ok(prop.type);
        assert.ok(prop.description);
      }
    }

    const input = getComponentEntry('ecCom', 'WeaInput');
    const onChange = input?.props.find(prop => prop.name === 'onChange');
    assert.ok(onChange?.description.includes('回调'));
    assert.ok(input?.props.find(prop => prop.name === 'viewAttr'));
  });

  test('parses component members and direct references', () => {
    assert.deepStrictEqual(parseComponentMemberContext('ecCom.WeaIn'), {
      namespace: 'ecCom',
      prefix: 'WeaIn',
    });
    assert.deepStrictEqual(parseComponentMemberContext('window.antd.Tab'), {
      namespace: 'antd',
      prefix: 'Tab',
    });

    const source = 'const Input = ecCom.WeaInput;';
    assert.strictEqual(
      findDirectComponentReferenceAt(source, source.indexOf('WeaInput') + 3)?.name,
      'WeaInput',
    );
  });

  test('tracks imported and destructured JSX component bindings', () => {
    const source = [
      'import { WeaInput as LocalInput } from "ecCom";',
      'const { Table: DataTable } = antd;',
      '<LocalInput ',
    ].join('\n');
    const bindings = getComponentBindings(source);
    assert.strictEqual(bindings.get('LocalInput')?.name, 'WeaInput');
    assert.strictEqual(bindings.get('DataTable')?.name, 'Table');

    const propContext = parseJsxPropContext(source, bindings);
    assert.strictEqual(propContext?.entry.name, 'WeaInput');
    assert.strictEqual(propContext?.prefix, '');
    assert.ok(propContext?.entry.props.some(prop => prop.name === 'value'));

    const tagContext = parseJsxComponentCompletionContext(
      'const content = <Local',
      bindings,
    );
    assert.strictEqual(tagContext?.prefix, 'Local');
    assert.ok(tagContext?.entries.some(entry => entry.name === 'WeaInput'));
  });

  test('does not repeat props already present on a JSX tag', () => {
    const bindings = getComponentBindings(
      'import { WeaInput } from "ecCom";',
    );
    const context = parseJsxPropContext(
      '<WeaInput value="text" onC',
      bindings,
    );
    assert.strictEqual(context?.prefix, 'onC');
    assert.ok(context?.usedProps.has('value'));
  });

  test('completes WeaBrowser tabs and WeaTable columns array items', () => {
    const bindings = getComponentBindings(
      'const { WeaBrowser, WeaTable } = window.ecCom;',
    );
    const browserContext = parseComponentNestedPropertyContext(
      '<WeaBrowser tabs={[{ key: "1", na',
      bindings,
    );
    assert.strictEqual(browserContext?.prefix, 'na');
    assert.ok(browserContext?.properties.some(property => property.name === 'name'));
    assert.ok(browserContext?.usedProperties.has('key'));

    const tableContext = parseComponentNestedPropertyContext(
      '<WeaTable columns={[{ title: "名称", data',
      bindings,
    );
    assert.strictEqual(tableContext?.prefix, 'data');
    assert.ok(tableContext?.properties.some(property => property.name === 'dataIndex'));
    assert.ok(tableContext?.usedProperties.has('title'));
  });

  test('supports nested component members below tabs and columns', () => {
    const browser = getComponentEntry('ecCom', 'WeaBrowser');
    const tabsSchema = browser
      ? getComponentPropSchema(browser, 'tabs')
      : undefined;
    assert.ok(tabsSchema);
    const browserProps = parseNestedPropertyContext(
      '[{ browserProps: { conditionDataParams: {}, page',
      tabsSchema!,
    );
    assert.strictEqual(browserProps?.prefix, 'page');
    assert.ok(browserProps?.properties.some(property => property.name === 'pageSize'));

    const table = getComponentEntry('ecCom', 'WeaTable');
    const columnsSchema = table
      ? getComponentPropSchema(table, 'columns')
      : undefined;
    const filters = parseNestedPropertyContext(
      '[{ filters: [{ text: "启用", val',
      columnsSchema!,
    );
    assert.strictEqual(filters?.prefix, 'val');
    assert.ok(filters?.properties.some(property => property.name === 'value'));
  });

  test('completes WfForm, ModeForm, and ecodeSDK object parameters', () => {
    const wfContext = parseApiNestedPropertyContext(
      'WfForm.changeFieldValue("field110", { value: "2", spe',
    );
    assert.strictEqual(wfContext?.prefix, 'spe');
    assert.ok(wfContext?.properties.some(property => property.name === 'specialobj'));
    assert.ok(wfContext?.usedProperties.has('value'));

    const specialObject = parseApiNestedPropertyContext(
      'WfForm.changeFieldValue("field110", { specialobj: [{ id: "2", na',
    );
    assert.strictEqual(specialObject?.prefix, 'na');
    assert.ok(specialObject?.properties.some(property => property.name === 'name'));

    const dialogButtons = parseApiNestedPropertyContext(
      'ModeForm.openCustomDialog({ title: "测试", url: "/test" }, [{ btn',
    );
    assert.strictEqual(dialogButtons?.prefix, 'btn');
    assert.ok(dialogButtons?.properties.some(property => property.name === 'btnname'));

    const sdkContext = parseApiNestedPropertyContext(
      'window.ecodeSDK.load({ id: "appId", no',
    );
    assert.strictEqual(sdkContext?.prefix, 'no');
    assert.ok(sdkContext?.properties.some(property => property.name === 'noCss'));
  });

  test('exposes nested schemas in API metadata', () => {
    const load = getApiEntry('ecodeSDK', 'load');
    const loadSchema = load
      ? getApiParameterSchema(load, 'options')
      : undefined;
    assert.ok(loadSchema?.properties?.some(property => property.name === 'cb'));

    const dialog = getApiEntry('ModeForm', 'openCustomDialog');
    const propsSchema = dialog
      ? getApiParameterSchema(dialog, 'props')
      : undefined;
    assert.ok(propsSchema?.properties?.some(property =>
      property.name === 'title' && property.required));
  });

  test('recognizes aliases created from window.ecCom', () => {
    const bindings = getComponentBindings([
      'const { WeaInput: LocalInput } = window.ecCom;',
      'const DirectTable = window.ecCom.WeaTable;',
    ].join('\n'));
    assert.strictEqual(bindings.get('LocalInput')?.name, 'WeaInput');
    assert.strictEqual(bindings.get('DirectTable')?.name, 'WeaTable');

    const directWindowContext = parseComponentNestedPropertyContext(
      '<window.ecCom.WeaTable columns={[{ data',
      bindings,
    );
    assert.ok(directWindowContext?.properties.some(property =>
      property.name === 'dataIndex'));
  });
});
