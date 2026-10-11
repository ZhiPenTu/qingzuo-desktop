import { JsonTree, MarkdownText, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives';

const markdownLabels = { code: { copyLabel: '复制代码', copiedLabel: '已复制' }, footnotes: '注释' };
const jsonLabels = { copyValue: '复制值', copyJson: '复制 JSON', copyPath: '复制属性名', copyPrettyJson: '复制格式化 JSON', copyCompactJson: '复制 JSON', copied: '已复制', copyFailed: '复制失败', collapseNode: '收起', expandNode: '展开', copyButtonTitle: (action: string) => action };

export function HarnessMessage({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return <MarkdownText text={text} streaming={streaming} labels={markdownLabels} />;
}
export function HarnessParameters({ data, label }: { data: Record<string, unknown>; label: string }) {
  return <JsonTree data={data} label={label} labels={jsonLabels} expandTopLevel copyable={false} />;
}
export function HarnessActivity() { return <TextShimmer active>助手正在处理…</TextShimmer>; }
