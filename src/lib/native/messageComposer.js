import { Capacitor, registerPlugin } from '@capacitor/core'

const MessageComposer = registerPlugin('MessageComposer')

export const isNativeIos = () => {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios'
  } catch {
    return false
  }
}

export const composeMessage = async ({ recipients, body, attachments }) => {
  if (!isNativeIos()) {
    throw new Error('not_native_ios')
  }
  const payload = {
    recipients: Array.isArray(recipients) ? recipients.filter(Boolean) : [],
    body: String(body ?? ''),
    attachments: Array.isArray(attachments) ? attachments : [],
  }
  return MessageComposer.composeMessage(payload)
}

