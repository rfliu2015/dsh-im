// English translations (telegram area). Keys are exact Chinese literals passed to t().
export default {
  // Terminal status written back over a placeholder whose in-place edit was
  // rejected, so it is the last thing a reader sees on a degraded reply.
  '回复已发送。': 'The reply was sent.',
  '回复发送结果未能确认。': 'The reply delivery result could not be confirmed.',
  '消息发送失败，请稍后重试。': 'The message could not be sent. Try again later.',
  '开启一个全新会话': 'Start a brand-new Session',
  '压缩当前会话的较早上下文': 'Compact the earlier context of the current Session',
  '切换工作区': 'Switch Workspace',
  // /start status screen: what this conversation is bound to, sent as a message
  // of its own so the picker card below can stay state-free.
  '查看当前工作区与会话': 'Show the current Workspace and Session',
  '/start  查看当前工作区与会话，并给出切换按钮':
    '/start  Show the current Workspace and Session, with buttons to switch',
  '暂时无法读取当前工作区，请稍后重试。':
    'Could not read the current Workspace right now. Try again later.',
  '当前会话：{sessionId}': 'Current Session: {sessionId}',
  '会话标题：{title}': 'Session title: {title}',
  '当前会话：本聊天尚未绑定会话，下一条消息会新建一个。':
    'Current Session: this chat is not bound to one yet; the next message will create it.',
  '下方按钮可切换工作区，选定后即可绑定该工作区的会话。':
    'The buttons below switch the Workspace; once there, you can bind one of its Sessions.',
  // /ws workspace picker card: one tap switches, the pressed card is re-marked in place.
  '选择要切换的工作区（共 {count} 个）：': 'Choose a Workspace to switch to ({count} total):',
  '这个列表已过期，请重新发送 /ws。': 'This list has expired. Send /ws again.',
  '正在切换工作区，请稍候。': 'Switching Workspaces, one moment.',
  '已经在工作区：{workspace}': 'Already in this Workspace: {workspace}',
  '暂时无法切换工作区，请稍后重试。': 'Could not switch Workspaces right now. Try again later.',
  // Session card: the workspace picker's second message, one row per Session.
  '选择要绑定的会话（共 {count} 个）：': 'Choose a Session to bind ({count} total):',
  '新增会话': 'New Session',
  '这个会话列表已过期，请重新发送 /ws。': 'This Session list has expired. Send /ws again.',
  '正在绑定会话，请稍候。': 'Binding the Session, one moment.',
  '已绑定会话。': 'Session bound.',
  '已新建会话并绑定。': 'New Session created and bound.',
  '已切换到第 {page} 页。': 'Moved to page {page}.',
  '暂时无法翻页，请稍后重试。': 'Could not turn the page right now. Try again later.',
  '已返回工作区列表，请重新选择。': 'Back to the Workspace list. Choose again.',
  '当前机器人暂不支持新建会话。': 'This bot does not support creating Sessions.',
  '机器人正在移除或已重新接入，无法新建会话。':
    'The bot is being removed or has been reconnected, so a Session cannot be created.',
  '暂时无法新建会话，请稍后重试。': 'Could not create a Session right now. Try again later.',
  '列出工作区绝对路径': 'List Workspace absolute paths',
  '列出会话 ID 和标题': 'List Session IDs and titles',
  '将当前聊天绑定到指定会话': 'Bind the current chat to a specific Session',
  '按序号列出所有可用模型': 'List all available models by number',
  '查看或切换当前会话模型': 'View or switch the model of the current Session',
  '列出可用 Agent Preset': 'List available Agent Presets',
  '查看或设置新会话 Agent Preset': 'View or set the Agent Preset for new Sessions',
  '停止当前任务': 'Stop the current task',
  '纠偏当前任务': 'Steer the current task',
  '检查连接状态': 'Check connection status',
  '查看插件版本': 'Show plugin version',
  '显示帮助': 'Show help',
  '该 Telegram 机器人已配置 Webhook，请先在原服务中移除 Webhook 后重试。':
    'This Telegram bot already has a Webhook configured. Remove the Webhook from the original service and try again.',
  '设置是否接收 DSH 侧对话的回答': 'Set whether DSH-side replies are received',
  '未命名会话 {number}': 'Untitled Session {number}',
  '选择要绑定的会话（共 {count} 个，第 {page}/{pages} 页）：':
    'Choose a Session to bind ({count} total, page {page}/{pages}):',
  '已经是这一页了。': 'This is already the current page.',
  '第 {page}/{pages} 页。': 'Page {page}/{pages}.',
  '用法：/notify [always|default]': 'Usage: /notify [always|default]',
  '当前 Host 不支持会话同步，无法使用 /notify。': 'This Host does not support Session sync, so /notify is unavailable.',
  '当前消息缺少机器人标识，无法使用 /notify。': 'This message carries no bot identity, so /notify is unavailable.',
  '/notify 仅支持在私聊中使用。': '/notify only works in a private chat.',
  '暂时无法读取投递设置，请稍后重试。': 'Could not read delivery settings right now. Try again later.',
  '当前模式：{mode}': 'Current mode: {mode}',
  'always（含 DSH 侧回答）': 'always (includes DSH-side replies)',
  'default（仅本聊天问答）': 'default (this chat only)',
  '/notify  查看当前通知模式': '/notify  show the current notification mode',
  '/notify default  只接收本聊天的问答结果': '/notify default  receive this chat only',
  '/notify always  同时接收 DSH 侧对话的回答': '/notify always  also receive replies from DSH-side chats',
  '这个聊天还没有投递目标。请先在 设置 → IM机器人 → 新建目标 中添加本聊天，再发送 /notify always。': 'This chat has no delivery target yet. Add it under Settings -> IM Bots -> New target, then send /notify always.',
  '这个聊天还不能同步会话：请先在此对话中发送一条消息建立会话，再试一次。': 'This chat cannot sync a Session yet: send a message here to establish one, then try again.',
  '暂时无法修改通知设置，请稍后重试。': 'Could not change the notification setting right now. Try again later.',
  '已开启：DSH 侧对话的回答也会发送到这里。': 'On: replies from DSH-side chats are sent here too.',
  '已关闭：只接收本聊天的问答结果。': 'Off: only this chat is received.',
  'Telegram机器人': 'Telegram Bot',
  ' Bot API 长轮询': ' Bot API long polling',
};
