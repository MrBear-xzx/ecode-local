export type EcodeComponentNamespace = 'ecCom' | 'antd';

export interface EcodeComponentProp {
  name: string;
  type: string;
  required: boolean;
  description: string;
  defaultValue?: string;
}

export interface EcodeComponentEntry {
  namespace: EcodeComponentNamespace;
  name: string;
  title: string;
  description: string;
  props: readonly EcodeComponentProp[];
  officialUrl: string;
}

export type ComponentPropDefinition = readonly [
  name: string,
  type: string,
  required: boolean,
  description: string,
  defaultValue: string,
];

export type ComponentDefinition = readonly [
  namespace: EcodeComponentNamespace,
  name: string,
  title: string,
  description: string,
  slug: string,
  props: readonly ComponentPropDefinition[],
];
