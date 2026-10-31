import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ModelSettings from './ModelSettings.svelte';
import { Desktop } from '../state/desktop.svelte';
import { bridge } from '../client';
import { newProvider, type ModelSettings as Config } from '../model-config';

afterEach(cleanup);
function fixture() {
  const p = newProvider('proxy');
  p.api = 'openai-responses';
  p.baseUrl = 'https://example.test/v1';
  const config: Config = {
    revision: 'r',
    directory: '/isolated',
    providers: [p],
    defaultProvider: null,
    defaultModel: null,
    defaultThinkingLevel: null,
  };
  const discoverModels = vi.fn().mockResolvedValue({
    models: [{ id: 'remote', name: 'Remote model' }],
    truncated: false,
  });
  const desktop = new Desktop({
    ...bridge,
    modelConfig: vi.fn().mockResolvedValue(config),
    discoverModels,
  });
  return { desktop, discoverModels, config };
}
describe('model settings', () => {
  it('lists only explicit endpoints and preserves hidden CLI providers when saving', async () => {
    const { desktop, config } = fixture();
    config.providers.push(newProvider('cli-only'));
    config.providers[0].models.push({
      id: 'catalog-override',
      overrideOnly: true,
      values: {},
      defaultThinking: null,
    });
    const save = vi
      .spyOn(desktop, 'saveModelConfig')
      .mockImplementation(async (value) => value);
    const view = render(ModelSettings, { desktop });
    await waitFor(() =>
      expect(view.getByLabelText('API 基础地址')).toBeInTheDocument(),
    );
    expect(view.queryByText('cli-only')).not.toBeInTheDocument();
    expect(
      view.queryByLabelText('从当前 Pi 目录添加覆盖'),
    ).not.toBeInTheDocument();
    expect(view.queryByText('catalog-override')).not.toBeInTheDocument();
    await fireEvent.input(view.getByLabelText('API 基础地址'), {
      target: { value: 'https://changed.test/v1' },
    });
    await view.component.save();
    expect(
      save.mock.calls[0][0].providers.find((p) => p.id === 'cli-only'),
    ).toEqual(newProvider('cli-only'));
    expect(save.mock.calls[0][0].providers[0].models[0].overrideOnly).toBe(
      true,
    );
  });
  it('creates a custom endpoint with an explicit protocol and requires an address before saving', async () => {
    const { desktop } = fixture();
    const save = vi.spyOn(desktop, 'saveModelConfig');
    const view = render(ModelSettings, { desktop });
    await waitFor(() =>
      expect(view.getByLabelText('API 基础地址')).toBeInTheDocument(),
    );
    await fireEvent.click(view.getByRole('button', { name: '添加端点' }));
    await fireEvent.input(view.getByLabelText('端点标识'), {
      target: { value: 'local' },
    });
    await fireEvent.click(view.getByRole('button', { name: '创建端点' }));
    expect(view.getByLabelText('显示名称')).toHaveValue('local');
    expect(view.getByLabelText('API Key')).toBeInTheDocument();
    expect(view.getByLabelText('API 协议')).toHaveValue('openai-completions');
    expect(view.getByRole('button', { name: '获取远端模型' })).toBeDisabled();
    expect(await view.component.save()).toBe(false);
    expect(save).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent(
        '请为自定义端点填写完整的 API 基础地址并选择协议',
      ),
    );
  });
  it('replaces keys only when entered and keeps existing authentication when cleared', async () => {
    const { desktop, discoverModels } = fixture();
    const view = render(ModelSettings, { desktop });
    await waitFor(() =>
      expect(view.getByLabelText('API Key')).toBeInTheDocument(),
    );
    const input = view.getByLabelText('API Key');
    expect(input).toHaveValue('');
    await fireEvent.input(input, { target: { value: 'test-key' } });
    await fireEvent.click(view.getByRole('button', { name: '获取远端模型' }));
    await waitFor(() => expect(discoverModels).toHaveBeenCalledTimes(1));
    expect(discoverModels.mock.calls[0][0].credential).toMatchObject({
      action: 'replace',
      value: 'test-key',
    });
    await fireEvent.input(input, { target: { value: '' } });
    await waitFor(() =>
      expect(
        view.getByRole('button', { name: '获取远端模型' }),
      ).not.toBeDisabled(),
    );
    await fireEvent.click(view.getByRole('button', { name: '获取远端模型' }));
    await waitFor(() => expect(discoverModels).toHaveBeenCalledTimes(2));
    expect(discoverModels.mock.calls[1][0].credential).toMatchObject({
      action: 'keep',
      value: '',
    });
  });
  it('adds remote models to the editable draft without saving', async () => {
    const { desktop, discoverModels } = fixture();
    const view = render(ModelSettings, { desktop });
    await waitFor(() =>
      expect(view.getByLabelText('API 基础地址')).toBeInTheDocument(),
    );
    await fireEvent.click(view.getByRole('button', { name: '获取远端模型' }));
    await waitFor(() =>
      expect(view.getByText('Remote model')).toBeInTheDocument(),
    );
    await fireEvent.click(view.getByRole('checkbox', { name: /Remote model/ }));
    await fireEvent.click(
      view.getByRole('button', { name: '添加所选模型到草稿' }),
    );
    const summary = view.getByText('Remote model', { selector: 'strong' });
    await fireEvent.click(summary);
    expect(view.getByLabelText('上下文长度（tokens）')).toBeInTheDocument();
    expect(view.getByLabelText('思考能力')).toBeInTheDocument();
    expect(discoverModels).toHaveBeenCalledOnce();
  });
  it('retains manual entry and reports discovery errors locally', async () => {
    const { desktop, discoverModels } = fixture();
    discoverModels.mockRejectedValue(new Error('目录接口不可用'));
    const view = render(ModelSettings, { desktop });
    await waitFor(() =>
      expect(view.getByLabelText('API 基础地址')).toBeInTheDocument(),
    );
    await fireEvent.click(view.getByRole('button', { name: '获取远端模型' }));
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent('目录接口不可用'),
    );
    expect(view.getByLabelText('API 基础地址')).toHaveValue(
      'https://example.test/v1',
    );
    await fireEvent.click(view.getByRole('button', { name: '手动添加模型' }));
    expect(view.getByText('新模型')).toBeInTheDocument();
  });
});
