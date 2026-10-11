export function validateToolSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 8 || !['object', 'array', 'string', 'integer', 'number', 'boolean'].includes(schema.type)) throw new Error('助手工具参数结构无效。');
  const allowed = ['type', 'description', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'maxLength', 'maxItems', 'minimum', 'maximum'];
  if (Object.keys(schema).some(key => !allowed.includes(key))) throw new Error('助手工具参数不支持此结构。');
  if (schema.description !== undefined && (typeof schema.description !== 'string' || schema.description.length > 500)) throw new Error('参数说明无效。');
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.length > 100 || schema.enum.some(value => !['string', 'number', 'boolean'].includes(typeof value)))) throw new Error('参数枚举无效。');
  for (const key of ['maxLength', 'maxItems', 'minimum', 'maximum']) if (schema[key] !== undefined && (!Number.isFinite(schema[key]) || (key.startsWith('max') && (!Number.isInteger(schema[key]) || schema[key] < 0)))) throw new Error('参数范围无效。');
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false || !schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties) || Object.keys(schema.properties).length > 32) throw new Error('工具对象必须声明属性且禁止额外属性。');
    for (const [key, value] of Object.entries(schema.properties)) { if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || /key|secret|password|credential|token|path/i.test(key)) throw new Error('工具不能接收密钥、令牌或文件路径。'); validateToolSchema(value, depth + 1); }
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => !Object.hasOwn(schema.properties, key)))) throw new Error('工具必填属性无效。');
  }
  if (schema.type === 'array') validateToolSchema(schema.items, depth + 1);
}
export function validateToolArgs(schema, value, depth = 0) {
  if (depth > 8) throw new Error('工具参数过深。');
  if (schema.enum && !schema.enum.includes(value)) throw new Error('工具参数不在允许范围。');
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(schema.properties, key)) || (schema.required || []).some(key => !Object.hasOwn(value, key))) throw new Error('工具参数属性无效。');
    for (const [key, input] of Object.entries(value)) validateToolArgs(schema.properties[key], input, depth + 1);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > (schema.maxItems ?? 200)) throw new Error('工具数组无效。');
    for (const input of value) validateToolArgs(schema.items, input, depth + 1);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length > (schema.maxLength ?? 32000)) throw new Error('工具文本无效。');
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error('工具布尔参数无效。');
  } else if (!Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value)) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) throw new Error('工具数值无效。');
}
