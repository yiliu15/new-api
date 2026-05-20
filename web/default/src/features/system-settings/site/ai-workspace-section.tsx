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
import * as z from 'zod'
import type { Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { FormDirtyIndicator } from '../components/form-dirty-indicator'
import { FormNavigationGuard } from '../components/form-navigation-guard'
import { SettingsSection } from '../components/settings-section'
import { useSettingsForm } from '../hooks/use-settings-form'
import { useUpdateOption } from '../hooks/use-update-option'

const aiWorkspaceSchema = z.object({
  AIWorkspaceEnabled: z.boolean(),
  AIWorkspaceBaseURL: z.string(),
  AIWorkspaceDefaultChatModel: z.string(),
  AIWorkspaceDefaultVisionModel: z.string(),
  AIWorkspaceDefaultImageModel: z.string(),
  AIWorkspaceDefaultImageEditModel: z.string(),
})

type AIWorkspaceSettings = z.infer<typeof aiWorkspaceSchema>

type AIWorkspaceSectionProps = {
  defaultValues: AIWorkspaceSettings
}

export function AIWorkspaceSection({
  defaultValues,
}: AIWorkspaceSectionProps) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()

  const { form, handleSubmit, isDirty, isSubmitting } =
    useSettingsForm<AIWorkspaceSettings>({
      resolver: zodResolver(aiWorkspaceSchema) as Resolver<
        AIWorkspaceSettings,
        unknown,
        AIWorkspaceSettings
      >,
      defaultValues,
      onSubmit: async (_data, changedFields) => {
        for (const [key, value] of Object.entries(changedFields)) {
          await updateOption.mutateAsync({
            key,
            value: value as string | boolean,
          })
        }
      },
    })

  return (
    <SettingsSection
      title={t('AI Workspace')}
      description={t('Configure the built-in AI chat and image workspace.')}
    >
      <FormNavigationGuard when={isDirty} />

      <Form {...form}>
        <form onSubmit={handleSubmit} className='space-y-6'>
          <FormDirtyIndicator isDirty={isDirty} />

          <FormField
            control={form.control}
            name='AIWorkspaceEnabled'
            render={({ field }) => (
              <FormItem className='flex flex-row items-center justify-between rounded-lg border p-4'>
                <div className='space-y-0.5 pe-4'>
                  <FormLabel className='text-base'>
                    {t('Enable AI Workspace')}
                  </FormLabel>
                  <FormDescription>
                    {t(
                      'Show the AI Workspace entry to users who have permission.'
                    )}
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    disabled={updateOption.isPending || isSubmitting}
                  />
                </FormControl>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name='AIWorkspaceBaseURL'
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('AI Workspace Base URL')}</FormLabel>
                <FormControl>
                  <Input placeholder='https://api.example.com' {...field} />
                </FormControl>
                <FormDescription>
                  {t('Leave empty to use the current New API site URL.')}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className='grid gap-4 md:grid-cols-2'>
            <FormField
              control={form.control}
              name='AIWorkspaceDefaultChatModel'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Default chat model')}</FormLabel>
                  <FormControl>
                    <Input placeholder='gpt-4o-mini' {...field} />
                  </FormControl>
                  <FormDescription>
                    {t('Used for normal text conversations.')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name='AIWorkspaceDefaultVisionModel'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Default vision model')}</FormLabel>
                  <FormControl>
                    <Input placeholder='gpt-4o' {...field} />
                  </FormControl>
                  <FormDescription>
                    {t('Used when users upload images for understanding.')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name='AIWorkspaceDefaultImageModel'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Default image generation model')}</FormLabel>
                  <FormControl>
                    <Input placeholder='gpt-image-1' {...field} />
                  </FormControl>
                  <FormDescription>
                    {t('Used when users ask to generate an image.')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name='AIWorkspaceDefaultImageEditModel'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Default image edit model')}</FormLabel>
                  <FormControl>
                    <Input placeholder='gpt-image-1' {...field} />
                  </FormControl>
                  <FormDescription>
                    {t('Used when users upload an image and request edits.')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <Button
            type='submit'
            disabled={updateOption.isPending || isSubmitting || !isDirty}
          >
            {updateOption.isPending || isSubmitting
              ? t('Saving...')
              : t('Save Changes')}
          </Button>
        </form>
      </Form>
    </SettingsSection>
  )
}
