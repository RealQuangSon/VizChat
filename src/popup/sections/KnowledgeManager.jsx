import { useTranslation } from 'react-i18next'
import PropTypes from 'prop-types'
import * as pdfjs from '../../js/js/pdf.mjs'
// DO NOT delete this import of worker. We need it to load the pdf work js.
import worker from '../../js/js/pdf.worker.mjs'
import { useEffect, useState, useCallback } from 'react'
import Browser from 'webextension-polyfill'
import { round } from 'lodash-es/math'
import { OpenAIEmbeddings } from '@langchain/openai'
import { MemoryVectorStore } from 'langchain/vectorstores/memory'
import { Document } from '@langchain/core/documents'
import { Checkbox, message } from 'antd'
import { splitText } from '../../background/index.mjs'

pdfjs.GlobalWorkerOptions.workerSrc = '../pdf.js/src/pdf.worker.js'

// ─── Phase 1: Document Upload ────────────────────────────────────────────────
function DocumentUploader({ config, updateConfig, docNameListLocal, setDocNameListLocal, checkUsageOfSpace, storageUsage }) {
  const { t } = useTranslation()
  const [selectedCheckBox, setSelectedCheckBox] = useState([])
  const [uploading, setUploading] = useState(false)

  const CheckboxGroup = Checkbox.Group

  const isFileExistLocal = async (filename) => {
    const fileRecord = await Browser.storage.local.get(filename)
    return Object.keys(fileRecord).length > 0
  }

  const recordDocument = async (documentName, documentContent) => {
    const res = await splitText(documentContent, config)
    try {
      const embeddings = new OpenAIEmbeddings({
        openAIApiKey: config.apiKey,
        batchSize: 512,
        modelName: 'text-embedding-3-small',
      })

      const docEmbedding = await embeddings.embedDocuments(res)

      const embeddingsToSave = {}
      embeddingsToSave[documentName] = {
        vector: docEmbedding,
        text: res,
      }
      let docNameList = await Browser.storage.local.get('docNameList')

      if (Object.keys(docNameList).length === 0) {
        const docNameList = []
        docNameList.push(documentName)
        await Browser.storage.local.set({ docNameList: docNameList })
      } else {
        docNameList = docNameList['docNameList']
        docNameList.push(documentName)
        await Browser.storage.local.set({ docNameList: docNameList })
      }
      Browser.storage.local.set(embeddingsToSave).then(() => {
        checkUsageOfSpace()
      })
      setDocNameListLocal((prevState) => [...prevState, documentName])
    } catch (e) {
      message.error(t('Document recording failed') + ': ' + e.toString())
    }
  }

  const extractPdfText = (file) => {
    return new Promise((resolve, reject) => {
      const fileReader = new FileReader()
      fileReader.onload = (e) => {
        const rawArray = new Uint8Array(e.target.result)
        pdfjs.getDocument({ data: rawArray }).promise.then(async (pdfRes) => {
          let fileText = ''
          for (let pageNum = 1; pageNum <= pdfRes.numPages; pageNum++) {
            const page = await pdfRes.getPage(pageNum)
            const text = await page.getTextContent()
            for (const itemsKey in text.items) {
              fileText += text.items[itemsKey].str
            }
          }
          resolve(fileText)
        }).catch(reject)
      }
      fileReader.onerror = reject
      fileReader.readAsArrayBuffer(file)
    })
  }

  const fileInputHandler = async (e) => {
    const files = Array.from(e.target.files)
    if (files.length === 0) return

    setUploading(true)
    let successCount = 0
    let skipCount = 0

    for (const file of files) {
      const filename = file.name
      if (await isFileExistLocal(filename)) {
        message.warning(`"${filename}" ${t('already exists, skipped')}`)
        skipCount++
        continue
      }
      try {
        const fileText = await extractPdfText(file)
        await recordDocument(filename, fileText)
        successCount++
      } catch (err) {
        message.error(`${t('Failed to process')} "${filename}": ${err.toString()}`)
      }
    }

    setUploading(false)
    if (successCount > 0) {
      message.success(`${t('Successfully uploaded')} ${successCount} ${t('file(s)')}`)
    }
    e.target.value = ''
  }

  const deleteHandler = async () => {
    if (selectedCheckBox.length === 0) return
    const docNameList = await Browser.storage.local.get('docNameList')
    const actualDocNameList = docNameList['docNameList'].slice()
    const updateList = []
    for (let i = 0; i < actualDocNameList.length; i++) {
      if (!selectedCheckBox.includes(i)) updateList.push(actualDocNameList[i])
      else await Browser.storage.local.remove(actualDocNameList[i])
    }
    Browser.storage.local.set({ docNameList: updateList }).then(() => {
      checkUsageOfSpace()
    })
    setDocNameListLocal(updateList)
    setSelectedCheckBox([])
    message.success(t('Deleted successfully'))
  }

  const chunkSizeHandler = (e) => {
    updateConfig({ chunkSize: e.target.value })
  }

  const onCheckBoxChange = (e) => {
    setSelectedCheckBox(e)
  }

  return (
    <div className="km-phase">
      <h3 style={{ marginBottom: '10px' }}>📁 {t('Document Upload')}</h3>

      <label htmlFor="ChunkSizeInputer">
        {t('Chunk size for splitting uploaded document')}
        <input
          id="ChunkSizeInputer"
          type="number"
          onChange={chunkSizeHandler}
          value={config.chunkSize}
        />
      </label>

      <label htmlFor="KnowledgeContextFileUploader">
        {t('Upload knowledge files (PDF)')}
        <input
          id="KnowledgeContextFileUploader"
          type="file"
          accept=".pdf"
          multiple
          onChange={fileInputHandler}
          disabled={uploading}
        />
      </label>
      {uploading && <div style={{ color: '#1890ff', fontSize: '13px' }}>{t('Uploading and processing...')}</div>}

      <div style={{ margin: '8px 0', fontSize: '13px', color: '#888' }}>
        {t('Storage usage')}: {storageUsage} MB
      </div>

      <hr />
      <label>{t('Saved knowledge files')} ({docNameListLocal.length})</label>

      {docNameListLocal.length === 0 ? (
        <div style={{ color: '#999', fontSize: '13px', padding: '8px 0' }}>{t('No documents uploaded yet')}</div>
      ) : (
        <CheckboxGroup
          value={selectedCheckBox}
          options={docNameListLocal.map((x, i) => ({
            label: x,
            value: i,
          }))}
          onChange={onCheckBoxChange}
        />
      )}

      <hr />
      <button type="button" onClick={deleteHandler} disabled={selectedCheckBox.length === 0}>
        {t('Delete selected document')}
      </button>
    </div>
  )
}

// ─── Phase 2: Document Operations ────────────────────────────────────────────
function DocumentOperations({ config, docNameListLocal }) {
  const { t } = useTranslation()
  const [operationType, setOperationType] = useState('qa')
  const [queryText, setQueryText] = useState('')
  const [resultText, setResultText] = useState('')
  const [processing, setProcessing] = useState(false)

  const operationTypes = [
    { key: 'qa', label: t('Q&A from documents') },
    { key: 'summarize', label: t('Summarize content') },
    { key: 'extract', label: t('Extract information') },
  ]

  const buildPromptByType = (type, question, context) => {
    switch (type) {
      case 'summarize':
        return `Based on the following document content, provide a comprehensive summary.\n\nDocument content:\n${context}\n\n${question ? `Focus on: ${question}` : 'Please summarize the key points.'}`
      case 'extract':
        return `Based on the following document content, extract the requested information.\n\nDocument content:\n${context}\n\nInformation to extract: ${question || 'Extract all key facts, names, dates, and important data.'}`
      case 'qa':
      default:
        return `Based on the following document content, answer the question.\n\nDocument content:\n${context}\n\nQuestion: ${question}`
    }
  }

  const getRelevantContext = async (question) => {
    const docNameList = await Browser.storage.local.get('docNameList')
    if (Object.keys(docNameList).length === 0) return ''

    const actualDocNameList = docNameList['docNameList']
    const embeddings = new OpenAIEmbeddings({
      openAIApiKey: config.apiKey,
      modelName: 'text-embedding-3-small',
    })
    const vectorStore = new MemoryVectorStore(embeddings)

    for (let i = 0; i < actualDocNameList.length; i++) {
      const aDocument = await Browser.storage.local.get(actualDocNameList[i])
      const actualDocument = aDocument[actualDocNameList[i]]
      const docs = actualDocument.text.map((txt) => new Document({ pageContent: txt }))
      await vectorStore.addVectors(actualDocument.vector, docs)
    }

    const retriever = vectorStore.asRetriever(4)
    const searchQuery = question || 'main content summary key information'
    const retrievedDocs = await retriever.getRelevantDocuments(searchQuery)

    return retrievedDocs.map((doc, i) => `${i + 1}. ${doc.pageContent}`).join('\n\n')
  }

  const callOpenAI = async (prompt) => {
    const baseUrl = (config.customOpenAiApiUrl || 'https://api.openai.com').replace(/\/$/, '')
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a helpful assistant that analyzes documents. Answer in the same language as the user question.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 2048,
      }),
    })
    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new Error(JSON.stringify(error) || `${response.status} ${response.statusText}`)
    }
    const data = await response.json()
    return data.choices[0].message.content
  }

  const handleExecute = async () => {
    if (operationType === 'qa' && !queryText.trim()) {
      message.warning(t('Please enter a question'))
      return
    }
    if (docNameListLocal.length === 0) {
      message.warning(t('Please upload documents first'))
      return
    }
    if (!config.apiKey) {
      message.error(t('Please configure API Key first'))
      return
    }

    setProcessing(true)
    setResultText('')

    try {
      const context = await getRelevantContext(queryText)
      if (!context) {
        setResultText(t('No relevant content found in documents'))
        setProcessing(false)
        return
      }

      const prompt = buildPromptByType(operationType, queryText, context)
      const result = await callOpenAI(prompt)
      setResultText(result)
    } catch (err) {
      message.error(t('Processing failed') + ': ' + err.toString())
      setResultText(t('Error') + ': ' + err.toString())
    } finally {
      setProcessing(false)
    }
  }

  const placeholderByType = {
    qa: t('Enter your question about the documents...'),
    summarize: t('Optional: specify what to focus on in the summary...'),
    extract: t('Specify what information to extract (e.g., names, dates, key data)...'),
  }

  return (
    <div className="km-phase">
      <h3 style={{ marginBottom: '10px' }}>🔍 {t('Document Operations')}</h3>

      {docNameListLocal.length === 0 && (
        <div style={{ color: '#ff8800', fontSize: '13px', marginBottom: '10px' }}>
          ⚠️ {t('No documents uploaded yet. Please upload documents in Phase 1.')}
        </div>
      )}

      <label>{t('Operation type')}</label>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
        {operationTypes.map((op) => (
          <button
            key={op.key}
            type="button"
            onClick={() => setOperationType(op.key)}
            style={{
              color: operationType === op.key ? '#1890ff' : 'inherit',
              padding: '6px 14px',
              borderRadius: '6px',
              border: operationType === op.key ? '2px solid #1890ff' : '1px solid #ccc',
              background: operationType === op.key ? '#e6f7ff' : 'transparent',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: operationType === op.key ? 'bold' : 'normal',
            }}
          >
            {op.label}
          </button>
        ))}
      </div>

      <label>
        {operationType === 'qa' ? t('Your question') : t('Additional instructions (optional)')}
        <textarea
          value={queryText}
          onChange={(e) => setQueryText(e.target.value)}
          placeholder={placeholderByType[operationType]}
          rows={3}
          style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
        />
      </label>

      <button
        type="button"
        onClick={handleExecute}
        disabled={processing || docNameListLocal.length === 0}
        style={{ marginTop: '8px' }}
      >
        {processing ? t('Processing...') : t('Execute')}
      </button>

      {resultText && (
        <div style={{
          marginTop: '12px',
          padding: '12px',
          border: '1px solid #d9d9d9',
          borderRadius: '8px',
          background: 'var(--theme-color)',
          whiteSpace: 'pre-wrap',
          fontSize: '13px',
          lineHeight: '1.6',
          maxHeight: '400px',
          overflowY: 'auto',
        }}>
          <label style={{ fontWeight: 'bold', marginBottom: '6px', display: 'block' }}>{t('Result')}</label>
          {resultText}
        </div>
      )}
    </div>
  )
}

// ─── Main Container ──────────────────────────────────────────────────────────
KnowledgeManager.propTypes = {
  config: PropTypes.object.isRequired,
  updateConfig: PropTypes.func.isRequired,
}

export function KnowledgeManager({ config, updateConfig }) {
  const { t } = useTranslation()
  const [activePhase, setActivePhase] = useState(1)
  const [storageUsage, setStorageUsage] = useState(0)
  const [docNameListLocal, setDocNameListLocal] = useState([])

  const checkUsageOfSpace = useCallback(() => {
    Browser.storage.local.getBytesInUse().then((res) => {
      setStorageUsage(round(res / 1024 / 1024, 3))
    })
  }, [])

  const checkDocNameListLocal = useCallback(() => {
    Browser.storage.local.get('docNameList').then((docNameList) => {
      if (Object.keys(docNameList).length === 0) return
      const actualDocNameList = docNameList['docNameList']
      setDocNameListLocal([...actualDocNameList])
    })
  }, [])

  useEffect(() => {
    checkUsageOfSpace()
    checkDocNameListLocal()
  }, [checkUsageOfSpace, checkDocNameListLocal])

  return (
    <>
      <label>
        {t('Conversation starter')}
        <input
          id="Conversation-starter"
          type="text"
          onChange={(e) => updateConfig({ initialCallBack: e.target.value })}
          value={config.initialCallBack}
        />
      </label>

      <div style={{ display: 'flex', gap: '6px', margin: '12px 0' }}>
        <button
          type="button"
          onClick={() => setActivePhase(1)}
          style={{
            color: activePhase === 1 ? '#1890ff' : 'inherit',
            padding: '8px 18px',
            borderRadius: '8px',
            border: activePhase === 1 ? '2px solid #1890ff' : '1px solid #ccc',
            background: activePhase === 1 ? '#e6f7ff' : 'transparent',
            cursor: 'pointer',
            fontWeight: activePhase === 1 ? 'bold' : 'normal',
          }}
        >
          📁 {t('Upload Documents')}
        </button>
        <button
          type="button"
          onClick={() => setActivePhase(2)}
          style={{
            color: activePhase === 2 ? '#1890ff' : 'inherit',
            padding: '8px 18px',
            borderRadius: '8px',
            border: activePhase === 2 ? '2px solid #1890ff' : '1px solid #ccc',
            background: activePhase === 2 ? '#e6f7ff' : 'transparent',
            cursor: 'pointer',
            fontWeight: activePhase === 2 ? 'bold' : 'normal',
          }}
        >
          🔍 {t('Document Operations')}
        </button>
      </div>

      <hr />

      {activePhase === 1 ? (
        <DocumentUploader
          config={config}
          updateConfig={updateConfig}
          docNameListLocal={docNameListLocal}
          setDocNameListLocal={setDocNameListLocal}
          checkUsageOfSpace={checkUsageOfSpace}
          storageUsage={storageUsage}
        />
      ) : (
        <DocumentOperations
          config={config}
          docNameListLocal={docNameListLocal}
        />
      )}
    </>
  )
}
