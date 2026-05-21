/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ImagePlus,
  KeyRound,
  Loader2,
  Settings2,
  Send,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { useStatus } from '@/hooks/use-status'
import { ROLE } from '@/lib/roles'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

type WorkspaceMode = 'auto' | 'chat' | 'vision' | 'image' | 'edit'
type ImageSize = 'auto' | '1024x1024' | '1024x1536' | '1536x1024'
type MessageRole = 'user' | 'assistant'
type MessageStatus = 'sending' | 'streaming' | 'done' | 'error'

type Attachment = {
  id: string
  file: File
  dataUrl: string
}

type WorkspaceMessage = {
  id: string
  role: MessageRole
  content: string
  images?: string[]
  generatedImages?: string[]
  status?: MessageStatus
}

type ChatMessageContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >

type ChatRequestMessage = {
  role: MessageRole
  content: ChatMessageContent
}

const STORAGE_KEYS = {
  apiKey: 'ai_workspace_api_key',
  chatModel: 'ai_workspace_chat_model',
  visionModel: 'ai_workspace_vision_model',
  imageModel: 'ai_workspace_image_model',
  editModel: 'ai_workspace_image_edit_model',
  imageSize: 'ai_workspace_image_size',
  mode: 'ai_workspace_mode',
}

const IMAGE_SIZE_OPTIONS: ImageSize[] = [
  'auto',
  '1024x1024',
  '1024x1536',
  '1536x1024',
]

const IMAGE_EDIT_KEYWORDS = [
  '增加',
  '添加',
  '加上',
  '加入',
  '编辑',
  '修改',
  '换成',
  '改成',
  '改为',
  '去掉',
  '移除',
  '删除',
  '背景',
  '替换',
  '水印',
  '贴纸',
  '文字',
  '标志',
  'logo',
  '相机',
  '今日相机',
  'add',
  'edit',
  'modify',
  'remove',
  'replace',
  'background',
  'watermark',
  'sticker',
  'text',
  'logo',
  'camera',
]

const IMAGE_GENERATION_KEYWORDS = [
  '生成图片',
  '画一张',
  '生成一张',
  '生图',
  '出图',
  '绘制',
  '画图',
  'generate image',
  'create image',
  'draw',
]

function getLocalStorageValue(key: string) {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(key) || ''
}

function setLocalStorageValue(key: string, value: string) {
  if (typeof window === 'undefined') return
  if (value) {
    window.localStorage.setItem(key, value)
  } else {
    window.localStorage.removeItem(key)
  }
}

function getStoredImageSize(): ImageSize {
  const value = getLocalStorageValue(STORAGE_KEYS.imageSize)
  return IMAGE_SIZE_OPTIONS.includes(value as ImageSize)
    ? (value as ImageSize)
    : 'auto'
}

function normalizeBaseUrl(value?: unknown) {
  const raw = typeof value === 'string' ? value.trim() : ''
  const base =
    raw || (typeof window !== 'undefined' ? window.location.origin : '')
  return base.replace(/\/+$/, '').replace(/\/v1$/i, '')
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function isSupportedImage(file: File) {
  return ['image/jpeg', 'image/png', 'image/webp'].includes(file.type)
}

function extractImageUrl(item: Record<string, unknown>) {
  if (typeof item.url === 'string') return item.url
  if (typeof item.b64_json === 'string') {
    return `data:image/png;base64,${item.b64_json}`
  }
  return ''
}

function extractChatContent(data: unknown) {
  const record = data as {
    choices?: Array<{ message?: { content?: string }; text?: string }>
  }
  return (
    record?.choices?.[0]?.message?.content ||
    record?.choices?.[0]?.text ||
    ''
  )
}

function readSseContent(buffer: string) {
  const chunks: string[] = []
  const lines = buffer.split('\n')

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') continue

    try {
      const json = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string }; text?: string }>
      }
      const content =
        json.choices?.[0]?.delta?.content || json.choices?.[0]?.text || ''
      if (content) chunks.push(content)
    } catch {
      // Ignore non-JSON SSE keepalive lines.
    }
  }

  return chunks.join('')
}

function resolveMode(mode: WorkspaceMode, text: string, hasImages: boolean) {
  if (mode !== 'auto') return mode

  const normalized = text.toLowerCase()
  if (
    hasImages &&
    IMAGE_EDIT_KEYWORDS.some((keyword) => normalized.includes(keyword))
  ) {
    return 'edit'
  }
  if (hasImages) return 'vision'
  if (
    IMAGE_GENERATION_KEYWORDS.some((keyword) => normalized.includes(keyword))
  ) {
    return 'image'
  }
  return 'chat'
}

export function AIWorkspace() {
  const { t } = useTranslation()
  const { status, loading: statusLoading } = useStatus()
  const { auth } = useAuthStore()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const baseUrl = useMemo(
    () => normalizeBaseUrl(status?.AIWorkspaceBaseURL),
    [status?.AIWorkspaceBaseURL]
  )
  const isAdmin = (auth.user?.role ?? 0) >= ROLE.ADMIN
  const canUseWorkspace =
    status?.AIWorkspaceEnabled === true &&
    (isAdmin || auth.user?.ai_workspace_enabled === true)

  const [apiKey, setApiKey] = useState(() =>
    getLocalStorageValue(STORAGE_KEYS.apiKey)
  )
  const [models, setModels] = useState<string[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [mode, setMode] = useState<WorkspaceMode>(
    () => (getLocalStorageValue(STORAGE_KEYS.mode) as WorkspaceMode) || 'auto'
  )
  const [chatModel, setChatModel] = useState(() =>
    getLocalStorageValue(STORAGE_KEYS.chatModel)
  )
  const [visionModel, setVisionModel] = useState(() =>
    getLocalStorageValue(STORAGE_KEYS.visionModel)
  )
  const [imageModel, setImageModel] = useState(() =>
    getLocalStorageValue(STORAGE_KEYS.imageModel)
  )
  const [editModel, setEditModel] = useState(() =>
    getLocalStorageValue(STORAGE_KEYS.editModel)
  )
  const [imageSize, setImageSize] = useState<ImageSize>(getStoredImageSize)
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [messages, setMessages] = useState<WorkspaceMessage[]>([])
  const [isSending, setIsSending] = useState(false)
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false)

  useEffect(() => {
    if (!chatModel && typeof status?.AIWorkspaceDefaultChatModel === 'string') {
      setChatModel(status.AIWorkspaceDefaultChatModel)
    }
    if (
      !visionModel &&
      typeof status?.AIWorkspaceDefaultVisionModel === 'string'
    ) {
      setVisionModel(status.AIWorkspaceDefaultVisionModel)
    }
    if (
      !imageModel &&
      typeof status?.AIWorkspaceDefaultImageModel === 'string'
    ) {
      setImageModel(status.AIWorkspaceDefaultImageModel)
    }
    if (
      !editModel &&
      typeof status?.AIWorkspaceDefaultImageEditModel === 'string'
    ) {
      setEditModel(status.AIWorkspaceDefaultImageEditModel)
    }
  }, [
    chatModel,
    editModel,
    imageModel,
    status?.AIWorkspaceDefaultChatModel,
    status?.AIWorkspaceDefaultImageEditModel,
    status?.AIWorkspaceDefaultImageModel,
    status?.AIWorkspaceDefaultVisionModel,
    visionModel,
  ])

  useEffect(() => {
    setLocalStorageValue(STORAGE_KEYS.apiKey, apiKey.trim())
  }, [apiKey])

  useEffect(() => {
    setLocalStorageValue(STORAGE_KEYS.chatModel, chatModel.trim())
  }, [chatModel])

  useEffect(() => {
    setLocalStorageValue(STORAGE_KEYS.visionModel, visionModel.trim())
  }, [visionModel])

  useEffect(() => {
    setLocalStorageValue(STORAGE_KEYS.imageModel, imageModel.trim())
  }, [imageModel])

  useEffect(() => {
    setLocalStorageValue(STORAGE_KEYS.editModel, editModel.trim())
  }, [editModel])

  useEffect(() => {
    setLocalStorageValue(STORAGE_KEYS.imageSize, imageSize)
  }, [imageSize])

  useEffect(() => {
    setLocalStorageValue(STORAGE_KEYS.mode, mode)
  }, [mode])

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [messages])

  useEffect(() => {
    if (!apiKey.trim() || !canUseWorkspace) {
      setModels([])
      return
    }

    let cancelled = false
    const loadModels = async () => {
      setModelsLoading(true)
      try {
        const response = await fetch(`${baseUrl}/v1/models`, {
          headers: {
            Authorization: `Bearer ${apiKey.trim()}`,
          },
        })
        if (!response.ok) {
          throw new Error(await response.text())
        }
        const data = (await response.json()) as {
          data?: Array<{ id?: string } | string>
        }
        const modelIds = (data.data || [])
          .map((item) => (typeof item === 'string' ? item : item.id || ''))
          .filter(Boolean)
        if (!cancelled) {
          setModels(modelIds)
          if (!chatModel && modelIds[0]) setChatModel(modelIds[0])
        }
      } catch {
        if (!cancelled) {
          setModels([])
          toast.error(t('Failed to load models'))
        }
      } finally {
        if (!cancelled) setModelsLoading(false)
      }
    }

    loadModels()

    return () => {
      cancelled = true
    }
  }, [apiKey, baseUrl, canUseWorkspace, chatModel, t])

  const selectedModelForMode = (resolvedMode: WorkspaceMode) => {
    switch (resolvedMode) {
      case 'vision':
        return visionModel || chatModel
      case 'image':
        return imageModel
      case 'edit':
        return editModel || imageModel
      default:
        return chatModel
    }
  }

  const appendMessage = (message: WorkspaceMessage) => {
    setMessages((current) => [...current, message])
  }

  const updateMessage = (
    id: string,
    updater: (message: WorkspaceMessage) => WorkspaceMessage
  ) => {
    setMessages((current) =>
      current.map((message) => (message.id === id ? updater(message) : message))
    )
  }

  const handleFiles = async (files: FileList | null) => {
    if (!files) return
    const selected = Array.from(files).slice(0, 4 - attachments.length)
    const validFiles = selected.filter((file) => {
      if (!isSupportedImage(file)) {
        toast.error(t('Only JPG, PNG, and WebP images are supported'))
        return false
      }
      if (file.size > 10 * 1024 * 1024) {
        toast.error(t('Image size must be under 10MB'))
        return false
      }
      return true
    })

    const nextAttachments = await Promise.all(
      validFiles.map(async (file) => ({
        id: makeId('attachment'),
        file,
        dataUrl: await fileToDataUrl(file),
      }))
    )
    setAttachments((current) => [...current, ...nextAttachments].slice(0, 4))
  }

  const buildChatMessages = (
    userText: string,
    currentAttachments: Attachment[]
  ): ChatRequestMessage[] => {
    const history: ChatRequestMessage[] = messages
      .filter((message) => message.content && !message.generatedImages?.length)
      .slice(-12)
      .map((message) => ({
        role: message.role,
        content: message.content,
      }))

    if (currentAttachments.length === 0) {
      return [...history, { role: 'user', content: userText }]
    }

    return [
      ...history,
      {
        role: 'user',
        content: [
          { type: 'text', text: userText || t('Please analyze this image.') },
          ...currentAttachments.map((attachment) => ({
            type: 'image_url',
            image_url: { url: attachment.dataUrl },
          })),
        ],
      },
    ]
  }

  const sendChat = async (
    userText: string,
    currentAttachments: Attachment[],
    resolvedMode: WorkspaceMode,
    assistantId: string
  ) => {
    const model = selectedModelForMode(resolvedMode)
    if (!model) throw new Error(t('Please select a model first'))

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify({
        model,
        messages: buildChatMessages(userText, currentAttachments),
        stream: true,
      }),
    })

    if (!response.ok) {
      throw new Error(await response.text())
    }

    if (!response.body) {
      const data = await response.json()
      updateMessage(assistantId, (message) => ({
        ...message,
        content: extractChatContent(data),
        status: 'done',
      }))
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let content = ''
    let sseBuffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      sseBuffer += decoder.decode(value, { stream: true })
      const events = sseBuffer.split(/\r?\n\r?\n/)
      sseBuffer = events.pop() || ''
      const delta = readSseContent(events.join('\n\n'))
      if (!delta) continue
      content += delta
      updateMessage(assistantId, (message) => ({
        ...message,
        content,
        status: 'streaming',
      }))
    }

    const remainingDelta = readSseContent(sseBuffer)
    if (remainingDelta) content += remainingDelta

    updateMessage(assistantId, (message) => ({
      ...message,
      content: content || message.content,
      status: 'done',
    }))
  }

  const sendImageGeneration = async (prompt: string, assistantId: string) => {
    if (!imageModel) throw new Error(t('Please select an image model first'))
    const response = await fetch(`${baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: imageModel,
        prompt,
        n: 1,
        size: imageSize,
      }),
    })

    if (!response.ok) throw new Error(await response.text())

    const data = (await response.json()) as { data?: Record<string, unknown>[] }
    const images = (data.data || []).map(extractImageUrl).filter(Boolean)
    updateMessage(assistantId, (message) => ({
      ...message,
      content: images.length
        ? t('Image generated successfully.')
        : t('No image was returned by the model.'),
      generatedImages: images,
      status: images.length ? 'done' : 'error',
    }))
  }

  const sendImageEdit = async (
    prompt: string,
    currentAttachments: Attachment[],
    assistantId: string
  ) => {
    const model = editModel || imageModel
    if (!model) throw new Error(t('Please select an image edit model first'))
    if (currentAttachments.length === 0) {
      throw new Error(t('Please upload an image first'))
    }

    const formData = new FormData()
    formData.append('model', model)
    formData.append('prompt', prompt)
    formData.append('n', '1')
    formData.append('size', imageSize)
    formData.append('image', currentAttachments[0].file)

    const response = await fetch(`${baseUrl}/v1/images/edits`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: formData,
    })

    if (!response.ok) throw new Error(await response.text())

    const data = (await response.json()) as { data?: Record<string, unknown>[] }
    const images = (data.data || []).map(extractImageUrl).filter(Boolean)
    updateMessage(assistantId, (message) => ({
      ...message,
      content: images.length
        ? t('Image edited successfully.')
        : t('No edited image was returned by the model.'),
      generatedImages: images,
      status: images.length ? 'done' : 'error',
    }))
  }

  const handleSend = async () => {
    const userText = input.trim()
    if (!userText && attachments.length === 0) return
    if (!apiKey.trim()) {
      toast.error(t('Please enter your API key first'))
      return
    }

    const currentAttachments = attachments
    const resolvedMode = resolveMode(mode, userText, currentAttachments.length > 0)
    const userMessage: WorkspaceMessage = {
      id: makeId('user'),
      role: 'user',
      content: userText || t('Please analyze this image.'),
      images: currentAttachments.map((attachment) => attachment.dataUrl),
      status: 'done',
    }
    const assistantId = makeId('assistant')

    appendMessage(userMessage)
    appendMessage({
      id: assistantId,
      role: 'assistant',
      content: '',
      status: 'sending',
    })
    setInput('')
    setAttachments([])
    setIsSending(true)

    try {
      if (resolvedMode === 'image') {
        await sendImageGeneration(userText, assistantId)
      } else if (resolvedMode === 'edit') {
        await sendImageEdit(userText, currentAttachments, assistantId)
      } else {
        await sendChat(userText, currentAttachments, resolvedMode, assistantId)
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t('Request failed')
      updateMessage(assistantId, (current) => ({
        ...current,
        content: message,
        status: 'error',
      }))
    } finally {
      setIsSending(false)
    }
  }

  const modelFields: Array<{
    label: string
    value: string
    setter: (value: string) => void
  }> = [
    { label: t('Chat model'), value: chatModel, setter: setChatModel },
    { label: t('Vision model'), value: visionModel, setter: setVisionModel },
    { label: t('Image model'), value: imageModel, setter: setImageModel },
    { label: t('Image edit model'), value: editModel, setter: setEditModel },
  ]

  const resolvedPreviewMode = resolveMode(mode, input, attachments.length > 0)
  const resolvedPreviewModel =
    selectedModelForMode(resolvedPreviewMode) || imageModel || chatModel
  const modeLabel =
    mode === 'auto'
      ? t('Auto')
      : t(
          mode === 'edit'
            ? 'Edit image'
            : mode === 'image'
              ? 'Generate image'
              : mode === 'vision'
                ? 'Image understanding'
                : 'Chat'
        )

  const workspaceControls = (
    <>
      <div className='grid gap-2 md:grid-cols-[minmax(180px,1fr)_minmax(150px,0.7fr)_auto] lg:w-[680px]'>
        <div className='relative'>
          <KeyRound className='text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2' />
          <Input
            type='password'
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={t('Paste your New API key')}
            className='pl-8'
          />
        </div>
        <select
          value={mode}
          onChange={(event) => setMode(event.target.value as WorkspaceMode)}
          className='border-input bg-background h-8 rounded-lg border px-2 text-sm'
        >
          <option value='auto'>{t('Auto')}</option>
          <option value='chat'>{t('Chat')}</option>
          <option value='vision'>{t('Image understanding')}</option>
          <option value='image'>{t('Generate image')}</option>
          <option value='edit'>{t('Edit image')}</option>
        </select>
        <Button
          variant='outline'
          onClick={() => setMessages([])}
          disabled={messages.length === 0 || isSending}
          className='gap-2'
        >
          <Trash2 className='h-4 w-4' />
          {t('Clear')}
        </Button>
      </div>

      <div className='mt-3 grid gap-2 md:grid-cols-5'>
        {modelFields.map(({ label, value, setter }) => (
          <label key={label} className='space-y-1'>
            <span className='text-muted-foreground text-xs'>{label}</span>
            <input
              list='ai-workspace-models'
              value={value}
              onChange={(event) => setter(event.target.value)}
              className='border-input bg-background h-8 w-full rounded-lg border px-2 text-sm'
              placeholder={modelsLoading ? t('Loading...') : t('Model name')}
            />
          </label>
        ))}
        <label className='space-y-1'>
          <span className='text-muted-foreground text-xs'>
            {t('Image size')}
          </span>
          <select
            value={imageSize}
            onChange={(event) => setImageSize(event.target.value as ImageSize)}
            className='border-input bg-background h-8 w-full rounded-lg border px-2 text-sm'
          >
            <option value='auto'>{t('Auto')}</option>
            <option value='1024x1024'>1024x1024</option>
            <option value='1024x1536'>1024x1536</option>
            <option value='1536x1024'>1536x1024</option>
          </select>
        </label>
        <datalist id='ai-workspace-models'>
          {models.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      </div>
    </>
  )

  if (statusLoading) {
    return (
      <div className='flex h-full items-center justify-center'>
        <Loader2 className='text-muted-foreground h-6 w-6 animate-spin' />
      </div>
    )
  }

  if (!canUseWorkspace) {
    return (
      <div className='mx-auto max-w-2xl p-6'>
        <Alert variant='destructive'>
          <AlertTitle>{t('AI Workspace unavailable')}</AlertTitle>
          <AlertDescription>
            {t(
              'AI Workspace is disabled or your account does not have permission to use it.'
            )}
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <div className='flex h-[calc(100dvh-4rem)] min-h-0 flex-col'>
      <div className='border-b px-3 py-3 sm:px-5'>
        <div className='flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between'>
          <div className='flex items-center gap-2'>
            <div className='bg-primary/10 text-primary flex h-9 w-9 items-center justify-center rounded-lg'>
              <Sparkles className='h-4 w-4' />
            </div>
            <div className='min-w-0 flex-1'>
              <h1 className='text-lg font-semibold'>{t('AI Workspace')}</h1>
              <p className='text-muted-foreground text-xs'>
                {t('Use your own New API key for chat and image tasks.')}
              </p>
            </div>
            <Button
              type='button'
              variant='outline'
              size='sm'
              onClick={() => setMobileSettingsOpen((open) => !open)}
              className='gap-2 md:hidden'
            >
              <Settings2 className='h-4 w-4' />
              {t('Settings')}
              <ChevronDown
                className={cn(
                  'h-4 w-4 transition-transform',
                  mobileSettingsOpen && 'rotate-180'
                )}
              />
            </Button>
          </div>

          <div className='hidden md:block'>{workspaceControls}</div>
        </div>

        <div className='mt-3 flex flex-wrap gap-2 md:hidden'>
          <span className='bg-muted text-muted-foreground rounded-full px-2.5 py-1 text-xs'>
            {modeLabel}
          </span>
          <span className='bg-muted text-muted-foreground rounded-full px-2.5 py-1 text-xs'>
            {imageSize}
          </span>
          {resolvedPreviewModel && (
            <span className='bg-muted text-muted-foreground max-w-full truncate rounded-full px-2.5 py-1 text-xs'>
              {resolvedPreviewModel}
            </span>
          )}
        </div>

        {mobileSettingsOpen && (
          <div className='bg-muted/30 mt-3 rounded-xl border p-3 md:hidden'>
            {workspaceControls}
          </div>
        )}
      </div>

      <div ref={scrollRef} className='min-h-0 flex-1 overflow-y-auto px-3 py-5'>
        {messages.length === 0 ? (
          <div className='mx-auto flex h-full max-w-2xl items-center justify-center'>
            <div className='space-y-3 text-center'>
              <div className='bg-muted mx-auto flex h-12 w-12 items-center justify-center rounded-xl'>
                <Sparkles className='text-muted-foreground h-5 w-5' />
              </div>
              <div>
                <h2 className='text-xl font-semibold'>{t('AI Workspace')}</h2>
                <p className='text-muted-foreground mt-1 text-sm'>
                  {t(
                    'Ask questions, upload images, generate images, or request edits in one conversation.'
                  )}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className='mx-auto flex max-w-4xl flex-col gap-4'>
            {messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  'flex',
                  message.role === 'user' ? 'justify-end' : 'justify-start'
                )}
              >
                <Card
                  className={cn(
                    'max-w-[88%] gap-3 p-3 shadow-none',
                    message.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted/40',
                    message.status === 'error' &&
                      'border-destructive/40 bg-destructive/10 text-destructive'
                  )}
                >
                  {message.images && message.images.length > 0 && (
                    <div className='grid grid-cols-2 gap-2'>
                      {message.images.map((image) => (
                        <img
                          key={image}
                          src={image}
                          alt=''
                          className='max-h-56 rounded-lg object-contain'
                        />
                      ))}
                    </div>
                  )}
                  {message.content ? (
                    <div className='whitespace-pre-wrap text-sm leading-6'>
                      {message.content}
                    </div>
                  ) : (
                    <div className='flex items-center gap-2 text-sm'>
                      <Loader2 className='h-4 w-4 animate-spin' />
                      {t('Working...')}
                    </div>
                  )}
                  {message.generatedImages &&
                    message.generatedImages.length > 0 && (
                      <div className='grid gap-2 sm:grid-cols-2'>
                        {message.generatedImages.map((image) => (
                          <a
                            key={image}
                            href={image}
                            target='_blank'
                            rel='noopener noreferrer'
                          >
                            <img
                              src={image}
                              alt=''
                              className='max-h-[420px] rounded-lg object-contain'
                            />
                          </a>
                        ))}
                      </div>
                    )}
                </Card>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className='border-t bg-background px-3 py-3 sm:px-5'>
        <div className='mx-auto max-w-4xl space-y-2'>
          {attachments.length > 0 && (
            <div className='flex flex-wrap gap-2'>
              {attachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className='bg-muted relative rounded-lg border p-1'
                >
                  <img
                    src={attachment.dataUrl}
                    alt=''
                    className='h-16 w-16 rounded object-cover'
                  />
                  <button
                    type='button'
                    className='bg-background absolute -top-2 -right-2 rounded-full border p-0.5'
                    onClick={() =>
                      setAttachments((current) =>
                        current.filter((item) => item.id !== attachment.id)
                      )
                    }
                  >
                    <X className='h-3 w-3' />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className='grid grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-2'>
            <input
              ref={fileInputRef}
              type='file'
              accept='image/jpeg,image/png,image/webp'
              multiple
              className='hidden'
              onChange={(event) => handleFiles(event.target.files)}
            />
            <Button
              type='button'
              variant='outline'
              size='icon-lg'
              onClick={() => fileInputRef.current?.click()}
              disabled={attachments.length >= 4 || isSending}
              title={t('Upload images')}
            >
              <Upload className='h-4 w-4' />
            </Button>
            <div className='space-y-1'>
              <Label className='sr-only'>{t('Message')}</Label>
              <Textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    handleSend()
                  }
                }}
                placeholder={t(
                  'Message AI Workspace, generate an image, or upload an image...'
                )}
                className='max-h-40 min-h-12 resize-none'
                disabled={isSending}
              />
            </div>
            <Button
              type='button'
              size='icon-lg'
              onClick={handleSend}
              disabled={isSending || (!input.trim() && attachments.length === 0)}
              title={t('Send')}
            >
              {isSending ? (
                <Loader2 className='h-4 w-4 animate-spin' />
              ) : mode === 'image' ? (
                <ImagePlus className='h-4 w-4' />
              ) : (
                <Send className='h-4 w-4' />
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
