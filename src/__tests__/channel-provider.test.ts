import { describe, it, expect } from 'vitest'
import { dirname, join } from 'node:path'
import {
  getProvider,
  getProviderType,
  getChannelToken,
  getChannelChatId,
  channelStateDir,
  resolveMainChannelBase,
  type ChannelProviderType,
} from '../channel-provider.js'

describe('getProviderType', () => {
  it('returns telegram by default', () => {
    expect(getProviderType(undefined)).toBe('telegram')
    expect(getProviderType('')).toBe('telegram')
    expect(getProviderType('anything')).toBe('telegram')
  })

  it('returns slack when explicitly set', () => {
    expect(getProviderType('slack')).toBe('slack')
  })
})

describe('getProvider', () => {
  it('returns telegram provider with correct pluginId', () => {
    const p = getProvider('telegram')
    expect(p.type).toBe('telegram')
    expect(p.pluginId).toBe('telegram@claude-plugins-official')
    expect(p.envKeys).toContain('TELEGRAM_BOT_TOKEN')
    expect(p.stateDir).toBe('telegram')
  })

  it('returns slack provider with correct pluginId', () => {
    const p = getProvider('slack')
    expect(p.type).toBe('slack')
    expect(p.pluginId).toBe('slack-channel@marveen-marketplace')
    expect(p.envKeys).toContain('SLACK_BOT_TOKEN')
    expect(p.stateDir).toBe('slack')
  })
})

describe('getChannelToken', () => {
  it('reads TELEGRAM_BOT_TOKEN for telegram', () => {
    const env = { TELEGRAM_BOT_TOKEN: 'tg-tok-123' }
    expect(getChannelToken('telegram', env)).toBe('tg-tok-123')
  })

  it('reads SLACK_BOT_TOKEN for slack', () => {
    const env = { SLACK_BOT_TOKEN: 'xoxb-123' }
    expect(getChannelToken('slack', env)).toBe('xoxb-123')
  })

  it('returns empty string when key is missing', () => {
    expect(getChannelToken('telegram', {})).toBe('')
    expect(getChannelToken('slack', {})).toBe('')
  })
})

describe('getChannelChatId', () => {
  it('reads ALLOWED_CHAT_ID for telegram', () => {
    const env = { ALLOWED_CHAT_ID: '1268077055' }
    expect(getChannelChatId('telegram', env)).toBe('1268077055')
  })

  it('reads SLACK_CHANNEL_ID for slack', () => {
    const env = { SLACK_CHANNEL_ID: 'C01234ABCDE' }
    expect(getChannelChatId('slack', env)).toBe('C01234ABCDE')
  })

  it('returns empty string when key is missing', () => {
    expect(getChannelChatId('telegram', {})).toBe('')
    expect(getChannelChatId('slack', {})).toBe('')
  })
})

describe('channelStateDir', () => {
  // The last segment is the provider; the BASE above it is install-dependent
  // (legacy ~/.claude/channels, or the parent of CHANNEL_STATE_DIR on an isolated
  // install -- e.g. ".claude-channels", whose own name contains "channels").
  it('uses telegram subdirectory for telegram', () => {
    expect(channelStateDir('telegram')).toMatch(/\/telegram$/)
  })

  it('uses slack subdirectory for slack', () => {
    expect(channelStateDir('slack')).toMatch(/\/slack$/)
  })

  it('puts every provider under one shared base', () => {
    expect(dirname(channelStateDir('telegram'))).toBe(dirname(channelStateDir('slack')))
  })

  it('uses agent dir when provided', () => {
    const dir = channelStateDir('telegram', '/tmp/agents/test-agent')
    expect(dir).toBe('/tmp/agents/test-agent/.claude/channels/telegram')
  })

  // MULTI-FLEET (B5): the main agent's channel state must follow CHANNEL_STATE_DIR.
  // While the dashboard resolved homedir() unconditionally, two fleets shared ONE
  // ~/.claude/channels/<provider> and each one's dashboard atomically overwrote the
  // other's access.json / invites.json / bot-token .env. Asserted on the pure
  // resolver so BOTH branches are reachable -- an isolated install's own .env sets
  // the override, which would otherwise hide the unset case.
  describe('resolveMainChannelBase', () => {
    it('unset override keeps the legacy shared ~/.claude/channels', () => {
      expect(resolveMainChannelBase('', '/home/u')).toBe('/home/u/.claude/channels')
    })

    it('takes the PARENT of the provider dir, so other providers get their own subdir', () => {
      const base = resolveMainChannelBase('/home/u/fleet2/.claude-main/channels/telegram', '/home/u')
      expect(base).toBe('/home/u/fleet2/.claude-main/channels')
      expect(join(base, 'slack')).toBe('/home/u/fleet2/.claude-main/channels/slack')
    })

    it('expands a leading ~', () => {
      expect(resolveMainChannelBase('~/f2/.claude-main/channels/telegram', '/home/u'))
        .toBe('/home/u/f2/.claude-main/channels')
    })

    it('two fleets never resolve to the same base', () => {
      const a = resolveMainChannelBase('/home/u/marveen/.claude-channels/telegram', '/home/u')
      const b = resolveMainChannelBase('/home/u/marveen-mini-games/.claude-main/channels/telegram', '/home/u')
      expect(a).not.toBe(b)
    })
  })
})

describe('formatMessage per provider', () => {
  it('telegram: converts markdown headers to bold', () => {
    const p = getProvider('telegram')
    expect(p.formatMessage('# Hello')).toContain('<b>Hello</b>')
  })

  it('telegram: converts **bold** to HTML', () => {
    const p = getProvider('telegram')
    expect(p.formatMessage('**bold**')).toBe('<b>bold</b>')
  })

  it('slack: converts markdown headers to mrkdwn bold', () => {
    const p = getProvider('slack')
    expect(p.formatMessage('# Hello')).toBe('*Hello*')
  })

  it('slack: converts **bold** to mrkdwn bold', () => {
    const p = getProvider('slack')
    expect(p.formatMessage('**bold**')).toBe('*bold*')
  })

  it('slack: converts links to mrkdwn format', () => {
    const p = getProvider('slack')
    expect(p.formatMessage('[text](https://example.com)')).toBe('<https://example.com|text>')
  })

  it('slack: converts strikethrough', () => {
    const p = getProvider('slack')
    expect(p.formatMessage('~~deleted~~')).toBe('~deleted~')
  })

  it('slack: converts checkboxes', () => {
    const p = getProvider('slack')
    expect(p.formatMessage('- [ ] todo')).toContain(':white_square:')
    expect(p.formatMessage('- [x] done')).toContain(':white_check_mark:')
  })
})

describe('splitMessage per provider', () => {
  it('telegram: uses 4096 char limit', () => {
    const p = getProvider('telegram')
    const text = 'A '.repeat(2500)
    const chunks = p.splitMessage(text)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096)
    }
  })

  it('slack: uses 4000 char limit', () => {
    const p = getProvider('slack')
    const text = 'A '.repeat(2500)
    const chunks = p.splitMessage(text)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4000)
    }
  })
})
