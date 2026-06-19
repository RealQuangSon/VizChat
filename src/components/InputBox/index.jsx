import { useEffect, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import { isFirefox, isMobile, isSafari, updateRefHeight } from '../../utils'
import { useTranslation } from 'react-i18next'
import { getUserConfig } from '../../config/index.mjs'

const suggestedPromptKeys = [
  'Suggested prompt 1',
  'Suggested prompt 2',
  'Suggested prompt 3',
]

export function InputBox({ onSubmit, enabled, postMessage, reverseResizeDir, onAttachChart }) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const [attachedImage, setAttachedImage] = useState(null)
  const [annotateOnBrowser, setAnnotateOnBrowser] = useState(false)
  const [annotateRequestedThisTurn, setAnnotateRequestedThisTurn] = useState(false)
  const [isCapturing, setIsCapturing] = useState(false)
  const [captureStatus, setCaptureStatus] = useState('')
  const reverseDivRef = useRef(null)
  const inputRef = useRef(null)
  const resizedRef = useRef(false)
  const [internalReverseResizeDir, setInternalReverseResizeDir] = useState(reverseResizeDir)

  useEffect(() => {
    setInternalReverseResizeDir(
      !isSafari() && !isFirefox() && !isMobile() ? internalReverseResizeDir : false,
    )
  }, [])

  const virtualInputRef = internalReverseResizeDir ? reverseDivRef : inputRef

  useEffect(() => {
    inputRef.current.focus()

    const onResizeY = () => {
      if (virtualInputRef.current.h !== virtualInputRef.current.offsetHeight) {
        virtualInputRef.current.h = virtualInputRef.current.offsetHeight
        if (!resizedRef.current) {
          resizedRef.current = true
          virtualInputRef.current.style.maxHeight = ''
        }
      }
    }
    virtualInputRef.current.h = virtualInputRef.current.offsetHeight
    virtualInputRef.current.addEventListener('mousemove', onResizeY)
  }, [])

  useEffect(() => {
    if (!resizedRef.current) {
      if (!internalReverseResizeDir) {
        updateRefHeight(inputRef)
        virtualInputRef.current.h = virtualInputRef.current.offsetHeight
        virtualInputRef.current.style.maxHeight = '160px'
      }
    }
  })

  useEffect(() => {
    if (enabled)
      getUserConfig().then((config) => {
        if (config.focusAfterAnswer) inputRef.current.focus()
      })
  }, [enabled])

  const submitQuestion = async (questionText) => {
    if (!enabled || !questionText) return

    const shouldAnnotate = annotateOnBrowser && annotateRequestedThisTurn

    let imageInfoForSubmit = attachedImage
    if (shouldAnnotate && !imageInfoForSubmit?.imageUrl && onAttachChart) {
      setIsCapturing(true)
      try {
        const captured = await onAttachChart()
        imageInfoForSubmit =
          typeof captured === 'string' ? { imageUrl: captured, width: null, height: null } : captured
        if (imageInfoForSubmit?.imageUrl) {
          setAttachedImage(imageInfoForSubmit)
          setCaptureStatus(t('Chart attached'))
        }
      } catch (error) {
        setCaptureStatus(t('Capture failed'))
        console.error('Capture failed:', error)
      } finally {
        setIsCapturing(false)
      }
    }

    onSubmit(questionText, imageInfoForSubmit, shouldAnnotate)
    setValue('')
    setAttachedImage(null)
    setAnnotateOnBrowser(false)
    setAnnotateRequestedThisTurn(false)
    setCaptureStatus('')
  }

  const handleKeyDownOrClick = (e) => {
    e.stopPropagation()
    if (e.type === 'click' || (e.keyCode === 13 && e.shiftKey === false)) {
      e.preventDefault()
      if (enabled) {
        submitQuestion(value)
      } else {
        postMessage({ stop: true })
      }
    }
  }

  const handleAttachChart = async (e) => {
    e.stopPropagation()
    e.preventDefault()
    if (!onAttachChart || isCapturing || !enabled) return

    setIsCapturing(true)
    setCaptureStatus('')
    try {
      const captured = await onAttachChart()
      const imageInfo =
        typeof captured === 'string' ? { imageUrl: captured, width: null, height: null } : captured
      if (imageInfo?.imageUrl) {
        setAttachedImage(imageInfo)
        setCaptureStatus(t('Chart attached'))
      }
    } catch (error) {
      setCaptureStatus(t('Capture failed'))
      console.error('Capture failed:', error)
    } finally {
      setIsCapturing(false)
      inputRef.current?.focus()
    }
  }

  return (
    <div className="input-box">
      <div className="suggested-prompts" aria-label="Suggested prompts">
        {suggestedPromptKeys.map((promptKey) => {
          const prompt = t(promptKey)
          return (
          <button
            key={promptKey}
            type="button"
            className="suggested-prompt-chip"
            disabled={!enabled}
            onClick={(e) => {
              e.stopPropagation()
              e.preventDefault()
              submitQuestion(prompt)
            }}
          >
            {prompt}
          </button>
          )
        })}
      </div>
      <div
        ref={reverseDivRef}
        style={
          internalReverseResizeDir && {
            transform: 'rotateX(180deg)',
            resize: 'vertical',
            overflow: 'hidden',
            minHeight: '160px',
          }
        }
      >
        <textarea
          dir="auto"
          ref={inputRef}
          disabled={false}
          className="interact-input"
          style={
            internalReverseResizeDir
              ? { transform: 'rotateX(180deg)', resize: 'none' }
              : { resize: 'vertical', minHeight: '70px' }
          }
          placeholder={
            enabled
              ? t('Type your question here\nEnter to send, shift + enter to break line')
              : t('Type your question here\nEnter to stop generating\nShift + enter to break line')
          }
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDownOrClick}
        />
      </div>
      <button
        type="button"
        className={`attach-chart-button${attachedImage ? ' attached' : ''}`}
        title={captureStatus || t('Attach chart screenshot')}
        disabled={!enabled || isCapturing}
        onClick={handleAttachChart}
      >
        {isCapturing ? t('Capturing...') : attachedImage ? t('Chart attached') : t('Attach chart')}
      </button>
      <button
        type="button"
        className={`annotate-overlay-button${annotateOnBrowser ? ' active' : ''}`}
        title={t('Annotate on page')}
        disabled={!enabled || isCapturing}
        onClick={(e) => {
          e.stopPropagation()
          e.preventDefault()
          setAnnotateOnBrowser((v) => {
            const next = !v
            setAnnotateRequestedThisTurn(next)
            return next
          })
        }}
      >
        {t('Annotate')}
      </button>
      <button
        type="button"
        className="clear-overlay-button"
        title={t('Clear overlay')}
        disabled={!enabled}
        onClick={(e) => {
          e.stopPropagation()
          e.preventDefault()
          onSubmit('', null, false, { clearOverlayOnly: true })
        }}
      >
        {t('Clear')}
      </button>
      <button
        type="button"
        className="submit-button"
        style={{
          backgroundColor: enabled ? '#30a14e' : '#cf222e',
        }}
        onClick={handleKeyDownOrClick}
      >
        {enabled ? t('Ask') : t('Stop')}
      </button>
    </div>
  )
}

InputBox.propTypes = {
  onSubmit: PropTypes.func.isRequired,
  enabled: PropTypes.bool.isRequired,
  reverseResizeDir: PropTypes.bool,
  postMessage: PropTypes.func.isRequired,
  onAttachChart: PropTypes.func,
}

export default InputBox
