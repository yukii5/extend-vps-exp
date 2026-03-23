import puppeteer from 'puppeteer'
import { writeFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'

const loginUrl = 'https://secure.xserver.ne.jp/xapanel/login/xvps/' // XServer VPS のログイン画面 URL
const continueButtonText = '無料VPSの利用を継続する' // 更新確認や最終送信で押す主ボタンの文言
const loginButtonText = 'ログインする' // ログインフォーム送信ボタンの文言
const captchaImageSelector = 'img[src^="data:image"], img[src^="data:"]' // data URL 形式の CAPTCHA 画像を拾う selector
const captchaInputSelector = '[placeholder*="上の画像"]' // 画像 CAPTCHA の入力欄を拾う selector
const authCodeSelector = '[name="auth_code"]' // 画像 CAPTCHA の送信値を保持する input 群の selector
const turnstileInputSelector = '[name="cf-turnstile-response"], [name="cf_challenge_response"]' // Turnstile token が入る hidden input の selector
const parsedTurnstileTimeoutMs = Number.parseInt(process.env.TURNSTILE_TIMEOUT_MS ?? '30000', 10) // 環境変数から読んだ Turnstile 待機時間の生値
const turnstileTimeoutMs = Number.isFinite(parsedTurnstileTimeoutMs) ? parsedTurnstileTimeoutMs : 30000 // Turnstile 自動生成を待つ実際のタイムアウト値
const parsedTurnstileSolverTimeoutMs = Number.parseInt(process.env.TURNSTILE_SOLVER_TIMEOUT_MS ?? '120000', 10) // 環境変数から読んだ solver 待機時間の生値
const turnstileSolverTimeoutMs = Number.isFinite(parsedTurnstileSolverTimeoutMs) ? parsedTurnstileSolverTimeoutMs : 120000 // solver から token が返るまで待つ実際のタイムアウト値
const turnstileSolverProvider = (process.env.TURNSTILE_SOLVER_PROVIDER || '2captcha').trim().toLowerCase() // 使う Turnstile solver の種別
const configuredBrowserUserAgent = (process.env.BROWSER_USER_AGENT ?? '').trim() // 明示指定があるときだけ使う送信用 User-Agent
const configuredBrowserPlatform = (process.env.BROWSER_PLATFORM ?? '').trim() // 必要なときだけ上書きする navigator.platform
const turnstileSolverApiKey = (
    process.env.TURNSTILE_SOLVER_API_KEY
    ?? process.env.TWOCAPTCHA_API_KEY
    ?? ''
).trim() // solver サービスへ接続するための API キー
const parsedHeadlessMode = (process.env.PUPPETEER_HEADLESS ?? 'true').trim().toLowerCase() // headless 実行かどうかの環境変数
const browserHeadless = parsedHeadlessMode === 'false' ? false : true // 明示的に false を渡したときだけ headed Chrome を使う

const args = ['--no-sandbox', '--disable-setuid-sandbox'] // GitHub Actions 向けの Chrome 起動オプション
if (process.env.PROXY_SERVER) {
    const proxyUrl = new URL(process.env.PROXY_SERVER) // browser 起動時に渡す proxy URL
    proxyUrl.username = ''
    proxyUrl.password = ''
    args.push(`--proxy-server=${proxyUrl}`.replace(/\/$/, ''))
}

// 失敗時の HTML とスクリーンショットを artifact 用に保存する。
async function saveDebugArtifacts(page, prefix) {
    const safePrefix = prefix.replace(/[^a-z0-9-_]/gi, '-').toLowerCase() // ファイル名に使えるように整形した接頭辞
    await page.screenshot({ path: `debug-${safePrefix}.png`, fullPage: true }).catch(() => {})
    const html = await page.content().catch(() => '') // 失敗時点の DOM 全体
    if (html) {
        await writeFile(`debug-${safePrefix}.html`, html)
    }
}

// Turnstile の描画状態と token の有無をページ上から収集する。
async function getTurnstileState(page) {
    return page.evaluate((selector) => {
        const container = document.querySelector('.cf-turnstile') // Turnstile の描画コンテナ
        const input = document.querySelector(selector) // token を保持する hidden input
        const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]') // 対話型 challenge が出る iframe
        const renderParams = globalThis.__turnstileRenderParams ?? {} // render hook で捕まえた sitekey などの引数
        const renderCalls = Array.isArray(globalThis.__turnstileRenderCalls) ? globalThis.__turnstileRenderCalls : []
        const challengeScripts = Array.from(document.querySelectorAll('script[src*="challenges.cloudflare.com"]'))
            .map(script => script.src)
        const scriptEvents = Array.isArray(globalThis.__turnstileScriptEvents) ? globalThis.__turnstileScriptEvents : []

        return {
            url: window.location.href,
            userAgent: navigator.userAgent,
            hasContainer: Boolean(container),
            hasIframe: Boolean(iframe),
            hasInput: Boolean(input),
            hasApi: Boolean(globalThis.turnstile && typeof globalThis.turnstile.render === 'function'),
            tokenLength: input?.value?.length ?? 0,
            sitekey: renderParams.sitekey ?? container?.getAttribute('data-sitekey') ?? null,
            action: renderParams.action ?? container?.getAttribute('data-action') ?? null,
            cData: renderParams.cData ?? renderParams.cdata ?? container?.getAttribute('data-cdata') ?? null,
            chlPageData: renderParams.chlPageData ?? null,
            hasCallback: Boolean(globalThis.__turnstileCallback),
            renderCallCount: renderCalls.length,
            widgetIds: Array.isArray(globalThis.__turnstileWidgetIds) ? globalThis.__turnstileWidgetIds : [],
            challengeScriptCount: challengeScripts.length,
            challengeScripts,
            scriptEvents,
        }
    }, turnstileInputSelector)
}

// 更新確認ページに画像 CAPTCHA や Turnstile が出ているかをまとめて確認する。
async function getRenewalPageState(page) {
    return page.evaluate(({ imageSelector, inputSelector, turnstileSelector, submitText }) => {
        const input = document.querySelector(inputSelector) // CAPTCHA 入力欄
        const directImage = document.querySelector(imageSelector) // data URL で直に見えている CAPTCHA 画像
        const relatedImage = input
            ?.closest('form, table, section, article, div')
            ?.querySelector('img') // 入力欄の近くにある通常 URL の画像
        const image = directImage ?? relatedImage ?? null // 実際に使う CAPTCHA 画像候補
        const submitNode = Array.from(document.querySelectorAll('a, button, input[type="submit"], input[type="button"]'))
            .find(node => (node.textContent ?? node.value ?? '').includes(submitText)) // 続行に使えそうな送信要素

        return {
            url: window.location.href,
            title: document.title,
            hasCaptchaImage: Boolean(image?.src),
            captchaImageSourceKind: image?.src?.startsWith('data:') ? 'data-url' : (image?.src ? 'url' : null),
            hasCaptchaInput: Boolean(input),
            hasTurnstile: Boolean(
                document.querySelector('.cf-turnstile')
                || document.querySelector('iframe[src*="challenges.cloudflare.com"]')
                || document.querySelector(turnstileSelector)
            ),
            hasContinueButton: Boolean(submitNode),
            bodySnippet: document.body?.innerText?.replace(/\s+/g, ' ').slice(0, 300) ?? '',
        }
    }, {
        imageSelector: captchaImageSelector,
        inputSelector: captchaInputSelector,
        turnstileSelector: turnstileInputSelector,
        submitText: continueButtonText,
    })
}

// Turnstile hidden input に token が入るまで待機する。
async function waitForTurnstileToken(page, timeoutMs) {
    await page.waitForFunction((selector) => {
        const input = document.querySelector(selector) // hidden input に token が入ったかを見る
        return Boolean(input?.value && input.value.length > 20)
    }, { timeout: timeoutMs }, turnstileInputSelector)

    const token = await page.evaluate((selector) => document.querySelector(selector)?.value ?? '', turnstileInputSelector) // 取得済み token 本文
    console.log('Turnstile token received', token.length)
}

// Turnstile iframe が見えている場合に中央をクリックして発火を試みる。
async function clickTurnstileWidget(page) {
    const iframe = await page.$('iframe[src*="challenges.cloudflare.com"]') // challenge iframe の ElementHandle
    if (!iframe) {
        return false
    }

    await iframe.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }))
    await setTimeout(1000)
    const box = await iframe.boundingBox() // クリック位置計算用の iframe 座標
    if (!box) {
        return false
    }

    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 100 })
    return true
}

// solver API との JSON 通信を共通化し、失敗時はレスポンスも含めて落とす。
async function requestJson(url, body) {
    let lastError = null
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }) // solver API への HTTP レスポンス
        const text = await response.text() // JSON 化前の生レスポンス
        let data
        try {
            data = JSON.parse(text)
        } catch {
            lastError = new Error(`Unexpected JSON response from ${url}: ${text.slice(0, 200)}`)
            if (response.status >= 500 && attempt < 3) {
                console.log('Retrying solver request after non-JSON server response', {
                    url,
                    attempt,
                    status: response.status,
                })
                await setTimeout(2000 * attempt)
                continue
            }
            throw lastError
        }

        if (!response.ok) {
            lastError = new Error(`Request to ${url} failed with ${response.status}: ${text.slice(0, 200)}`)
            if (response.status >= 500 && attempt < 3) {
                console.log('Retrying solver request after server error', {
                    url,
                    attempt,
                    status: response.status,
                })
                await setTimeout(2000 * attempt)
                continue
            }
            throw lastError
        }

        return data
    }

    throw lastError ?? new Error(`Request to ${url} failed after retries`)
}

// 2Captcha に渡す Turnstile task を、必要なら proxy 情報付きで組み立てる。
function build2CaptchaTask(state) {
    const task = {
        type: 'TurnstileTaskProxyless',
        websiteURL: state.url,
        websiteKey: state.sitekey,
    } // 2Captcha に送る基本 task 情報

    if (state.action) {
        task.action = state.action
    }
    if (state.cData) {
        task.data = state.cData
    }
    if (state.chlPageData) {
        task.pagedata = state.chlPageData
    }
    if (state.userAgent) {
        task.userAgent = state.userAgent
    }

    if (!process.env.PROXY_SERVER) {
        return task
    }

    const proxy = new URL(process.env.PROXY_SERVER) // 2Captcha 側に渡す proxy 設定
    task.type = 'TurnstileTask'
    task.proxyType = proxy.protocol.replace(':', '') === 'https' ? 'http' : proxy.protocol.replace(':', '')
    task.proxyAddress = proxy.hostname
    task.proxyPort = Number.parseInt(proxy.port || (proxy.protocol === 'https:' ? '443' : '80'), 10)
    if (proxy.username) {
        task.proxyLogin = decodeURIComponent(proxy.username)
    }
    if (proxy.password) {
        task.proxyPassword = decodeURIComponent(proxy.password)
    }
    return task
}

// 2Captcha を使って Turnstile token を取得する。
async function solveTurnstile(page) {
    if (turnstileSolverProvider !== '2captcha') {
        throw new Error(`Unsupported TURNSTILE_SOLVER_PROVIDER: ${turnstileSolverProvider}`)
    }
    if (!turnstileSolverApiKey) {
        throw new Error('TURNSTILE_SOLVER_API_KEY is not set')
    }

    const state = await getTurnstileState(page) // solver に渡す前の Turnstile 状態
    if (!state.sitekey) {
        throw new Error(`Turnstile sitekey was not found: ${JSON.stringify(state)}`)
    }

    const createResult = await requestJson('https://api.2captcha.com/createTask', {
        clientKey: turnstileSolverApiKey,
        task: build2CaptchaTask(state),
    }) // 2Captcha に task を登録した結果
    if (createResult.errorId) {
        throw new Error(`2Captcha createTask failed: ${createResult.errorCode ?? createResult.errorDescription ?? createResult.errorId}`)
    }

    const deadline = Date.now() + turnstileSolverTimeoutMs // polling を打ち切る時刻
    while (Date.now() < deadline) {
        await setTimeout(5000)
        const result = await requestJson('https://api.2captcha.com/getTaskResult', {
            clientKey: turnstileSolverApiKey,
            taskId: createResult.taskId,
        }) // 2Captcha の polling 結果

        if (result.errorId) {
            throw new Error(`2Captcha getTaskResult failed: ${result.errorCode ?? result.errorDescription ?? result.errorId}`)
        }
        if (result.status === 'processing') {
            continue
        }
        if (result.status === 'ready' && result.solution?.token) {
            console.log('2Captcha solved Turnstile', {
                cost: result.cost,
                ip: result.ip,
                solveCount: result.solveCount,
                userAgent: result.solution.userAgent ?? null,
            })
            return {
                token: result.solution.token,
                userAgent: result.solution.userAgent ?? state.userAgent,
            }
        }

        throw new Error(`2Captcha returned unexpected status: ${JSON.stringify(result)}`)
    }

    throw new Error(`2Captcha timed out after ${turnstileSolverTimeoutMs}ms`)
}

// 取得した Turnstile token を hidden input と callback に注入する。
async function applyTurnstileToken(page, token) {
    await page.evaluate((value) => {
        const setFieldValue = (selector, name, { createIfMissing = false } = {}) => {
            const fields = Array.from(document.querySelectorAll(selector)) // 同名 field が複数あるケースもまとめて更新する対象一覧
            if (fields.length === 0 && createIfMissing) {
                const field = document.createElement('input')
                field.type = 'hidden'
                field.name = name
                ;(document.querySelector('form') ?? document.body).appendChild(field)
                fields.push(field)
            }

            for (const field of fields) {
                field.value = value
                if ('defaultValue' in field) {
                    field.defaultValue = value
                }
                if (typeof field.setAttribute === 'function') {
                    field.setAttribute('value', value)
                }
                field.dispatchEvent(new Event('input', { bubbles: true }))
                field.dispatchEvent(new Event('change', { bubbles: true }))
            }
        } // 指定 input を作成または取得して token を流し込む helper

        setFieldValue('[name="cf-turnstile-response"]', 'cf-turnstile-response', { createIfMissing: true })
        setFieldValue('[name="cf_challenge_response"]', 'cf_challenge_response')
        setFieldValue('[name="g-recaptcha-response"]', 'g-recaptcha-response')

        if (typeof globalThis.__turnstileCallback === 'function') {
            globalThis.__turnstileCallback(value)
        }
        if (Array.isArray(globalThis.__turnstileCallbacks)) {
            for (const callback of globalThis.__turnstileCallbacks) {
                if (typeof callback !== 'function') {
                    continue
                }
                try {
                    callback(value)
                } catch (error) {
                    console.log('Turnstile callback invocation failed', String(error))
                }
            }
        }
    }, token)
}

// ページ側が widget を自動描画できていない場合に、API script を明示的に読み込む。
async function ensureTurnstileApi(page) {
    return page.evaluate(async () => {
        const recordEvent = (type, detail = {}) => {
            globalThis.__turnstileScriptEvents = [
                ...(Array.isArray(globalThis.__turnstileScriptEvents) ? globalThis.__turnstileScriptEvents : []),
                {
                    type,
                    detail,
                    at: Date.now(),
                },
            ]
        }

        if (globalThis.turnstile && typeof globalThis.turnstile.render === 'function') {
            recordEvent('api-already-available')
            return { available: true, injected: false }
        }

        const existing = document.querySelector('script[data-codex-turnstile-api]')
        if (!existing) {
            const script = document.createElement('script')
            script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
            script.async = true
            script.defer = true
            script.dataset.codexTurnstileApi = 'true'
            script.addEventListener('load', () => {
                recordEvent('script-load', { src: script.src })
            })
            script.addEventListener('error', () => {
                recordEvent('script-error', { src: script.src })
            })
            document.head.appendChild(script)
            recordEvent('script-injected', { src: script.src })
        } else {
            recordEvent('script-already-present', { src: existing.src })
        }

        try {
            await new Promise((resolve, reject) => {
                const startedAt = Date.now()
                const timer = setInterval(() => {
                    if (globalThis.turnstile && typeof globalThis.turnstile.render === 'function') {
                        clearInterval(timer)
                        recordEvent('api-became-available')
                        resolve()
                        return
                    }
                    if (Date.now() - startedAt > 10000) {
                        clearInterval(timer)
                        recordEvent('api-timeout')
                        reject(new Error('Timed out while waiting for Turnstile API'))
                    }
                }, 100)
            })
            return { available: true, injected: true }
        } catch (error) {
            return {
                available: false,
                injected: true,
                error: String(error),
            }
        }
    })
}

// 自動描画されない widget を明示 render して iframe/callback を作らせる。
async function forceRenderTurnstile(page) {
    return page.evaluate(() => {
        const api = globalThis.turnstile
        const container = document.querySelector('.cf-turnstile')
        if (!container) {
            return { ok: false, reason: 'missing-container' }
        }
        if (!api || typeof api.render !== 'function') {
            return { ok: false, reason: 'missing-api' }
        }
        if (container.querySelector('iframe[src*="challenges.cloudflare.com"]')) {
            return { ok: true, reason: 'iframe-already-present' }
        }

        const sitekey = container.getAttribute('data-sitekey') || globalThis.__turnstileRenderParams?.sitekey || null
        if (!sitekey) {
            return { ok: false, reason: 'missing-sitekey' }
        }

        const setToken = (value) => {
            const fields = Array.from(document.querySelectorAll('[name="cf-turnstile-response"], [name="cf_challenge_response"], [name="g-recaptcha-response"]'))
            for (const field of fields) {
                field.value = value
                if ('defaultValue' in field) {
                    field.defaultValue = value
                }
                field.setAttribute?.('value', value)
                field.dispatchEvent(new Event('input', { bubbles: true }))
                field.dispatchEvent(new Event('change', { bubbles: true }))
            }
        }

        try {
            container.innerHTML = ''
            const widgetId = api.render(container, {
                sitekey,
                action: container.getAttribute('data-action') || undefined,
                cData: container.getAttribute('data-cdata') || undefined,
                callback: (value) => {
                    setToken(value)
                    globalThis.__turnstileManualCallbackValue = value
                },
                'expired-callback': () => {
                    globalThis.__turnstileManualExpired = true
                },
                'error-callback': (code) => {
                    globalThis.__turnstileManualError = code ?? true
                },
            })
            return {
                ok: true,
                reason: 'render-called',
                widgetId,
                sitekey,
                action: container.getAttribute('data-action') || null,
                cData: container.getAttribute('data-cdata') || null,
            }
        } catch (error) {
            return {
                ok: false,
                reason: 'render-threw',
                error: String(error),
            }
        }
    })
}

// Turnstile を自動待機、クリック、solver の順で解決する。
async function ensureTurnstileReady(page) {
    const state = await getTurnstileState(page) // 現在の Turnstile 状態
    if (!state.hasContainer && !state.hasIframe && !state.hasInput) {
        console.log('Turnstile widget not found')
        return
    }
    if (state.tokenLength > 20) {
        console.log('Turnstile token already present', state.tokenLength)
        return
    }

    console.log('Waiting for Turnstile token', state)
    const firstWaitMs = Math.min(turnstileTimeoutMs, 5000) // まずは短時間だけ自動生成を待つ
    try {
        await waitForTurnstileToken(page, firstWaitMs)
        return
    } catch (error) {
        console.log('Turnstile token was not generated automatically', error.message)
    }

    if (!state.hasIframe) {
        console.log('Turnstile API ensure result', await ensureTurnstileApi(page))
        console.log('Turnstile manual render result', await forceRenderTurnstile(page))
        await setTimeout(1000)
        console.log('Turnstile state after manual render attempt', await getTurnstileState(page))
    }

    if (await clickTurnstileWidget(page)) {
        console.log('Clicked Turnstile widget, waiting for token again')
    } else {
        console.log('Turnstile widget click was not available')
    }

    try {
        await waitForTurnstileToken(page, turnstileTimeoutMs)
    } catch {
        console.log('Turnstile token was still unavailable', await getTurnstileState(page))
        const solution = await solveTurnstile(page) // solver が返した token と UA
        if (solution.userAgent) {
            await page.setUserAgent(solution.userAgent)
            console.log('Updated browser user agent to solver value', solution.userAgent)
        }
        await applyTurnstileToken(page, solution.token)
        console.log('Injected Turnstile token from solver')
    }
}

// 送信前後の比較に使うため、現在のページ状態をスナップショットとして保存する。
async function getPageChangeSnapshot(page) {
    return page.evaluate(({ imageSelector, inputSelector, turnstileSelector }) => {
        const image = document.querySelector(imageSelector)
        const input = document.querySelector(inputSelector)
        const turnstileInput = document.querySelector(turnstileSelector)

        return {
            url: window.location.href,
            title: document.title,
            captchaSrc: image?.src ?? null,
            captchaValue: input?.value ?? '',
            turnstileValue: turnstileInput?.value ?? '',
            bodySnippet: document.body?.innerText?.replace(/\s+/g, ' ').slice(0, 400) ?? '',
        }
    }, {
        imageSelector: captchaImageSelector,
        inputSelector: captchaInputSelector,
        turnstileSelector: turnstileInputSelector,
    })
}

// 送信後に POST や DOM 変化が起きたかを把握するための診断情報を収集する。
async function getSubmitDiagnostics(page) {
    return page.evaluate(({ inputSelector, turnstileSelector, buttonText }) => {
        const input = document.querySelector(inputSelector)
        const turnstileInput = document.querySelector(turnstileSelector)
        const submitButton = Array.from(document.querySelectorAll('input[type="submit"], input[type="button"], button, a'))
            .find(node => (node.textContent ?? node.value ?? '').includes(buttonText))
        const form = input?.closest('form') ?? submitButton?.closest('form') ?? document.querySelector('form')
        const messages = Array.from(document.querySelectorAll('.error, .alert, .warning, .notice, .message, .formError'))
            .map(node => node.textContent?.trim())
            .filter(Boolean)

        return {
            url: window.location.href,
            title: document.title,
            formAction: form?.action ?? null,
            formMethod: form?.method ?? null,
            captchaValue: input?.value ?? '',
            turnstileTokenLength: turnstileInput?.value?.length ?? 0,
            submitButtonDisabled: Boolean(submitButton?.disabled),
            messages,
            bodySnippet: document.body?.innerText?.replace(/\s+/g, ' ').slice(0, 600) ?? '',
        }
    }, {
        inputSelector: captchaInputSelector,
        turnstileSelector: turnstileInputSelector,
        buttonText: continueButtonText,
    })
}

// 送信前後の詳細確認用に、認証関連 field と form の状態を広めに収集する。
async function getVerificationDiagnostics(page) {
    return page.evaluate(({ captchaSelector, authSelector, turnstileSelector, buttonText }) => {
        const previewValue = (value) => {
            const text = String(value ?? '')
            return text.length > 24 ? `${text.slice(0, 12)}...${text.slice(-6)}` : text
        } // ログを見やすくするための短縮表示
        const summarizeField = (field) => ({
            tagName: field.tagName,
            type: 'type' in field ? field.type ?? null : null,
            name: 'name' in field ? field.name ?? null : null,
            id: field.id ?? null,
            disabled: 'disabled' in field ? Boolean(field.disabled) : null,
            hidden: field instanceof HTMLElement ? field.hidden : null,
            valueLength: 'value' in field ? String(field.value ?? '').length : 0,
            valuePreview: 'value' in field ? previewValue(field.value) : null,
            attributeValueLength: typeof field.getAttribute === 'function' ? String(field.getAttribute('value') ?? '').length : 0,
            attributeValuePreview: typeof field.getAttribute === 'function' ? previewValue(field.getAttribute('value') ?? '') : null,
        }) // 各 input 要素の要約

        const captchaFields = Array.from(document.querySelectorAll(captchaSelector))
        const authCodeFields = Array.from(document.querySelectorAll(authSelector))
        const turnstileFields = Array.from(document.querySelectorAll('[name="cf-turnstile-response"]'))
        const cfChallengeFields = Array.from(document.querySelectorAll('[name="cf_challenge_response"]'))
        const grecaptchaFields = Array.from(document.querySelectorAll('[name="g-recaptcha-response"]'))
        const csrfFields = Array.from(document.querySelectorAll('[name="ethna_csrf"]'))
        const submitButton = (
            typeof globalThis.submit_button !== 'undefined'
            && globalThis.submit_button
        ) ? globalThis.submit_button : Array.from(document.querySelectorAll('input[type="submit"], input[type="button"], button, a'))
            .find(node => (node.textContent ?? node.value ?? '').includes(buttonText))
        const form = captchaFields[0]?.closest('form') ?? authCodeFields[0]?.closest('form') ?? submitButton?.closest?.('form') ?? document.querySelector('form')
        const formFields = form ? Array.from(form.elements).map((field) => ({
            tagName: field.tagName,
            type: 'type' in field ? field.type ?? null : null,
            name: 'name' in field ? field.name ?? null : null,
            id: field.id ?? null,
            disabled: 'disabled' in field ? Boolean(field.disabled) : null,
            valueLength: 'value' in field ? String(field.value ?? '').length : 0,
            valuePreview: 'value' in field ? previewValue(field.value) : null,
        })) : []

        return {
            url: window.location.href,
            title: document.title,
            cookieNames: document.cookie
                .split('; ')
                .filter(Boolean)
                .map(entry => entry.split('=')[0]),
            captchaFields: captchaFields.map(summarizeField),
            authCodeFields: authCodeFields.map(summarizeField),
            turnstileFields: turnstileFields.map(summarizeField),
            cfChallengeFields: cfChallengeFields.map(summarizeField),
            grecaptchaFields: grecaptchaFields.map(summarizeField),
            csrfFields: csrfFields.map(summarizeField),
            submitButton: submitButton ? {
                tagName: submitButton.tagName ?? null,
                type: 'type' in submitButton ? submitButton.type ?? null : null,
                name: 'name' in submitButton ? submitButton.name ?? null : null,
                id: submitButton.id ?? null,
                disabled: 'disabled' in submitButton ? Boolean(submitButton.disabled) : null,
                text: submitButton.textContent?.trim() ?? submitButton.value ?? null,
                className: submitButton.className ?? null,
                hasOnclick: typeof submitButton.onclick === 'function',
            } : null,
            form: form ? {
                action: form.action ?? null,
                method: form.method ?? null,
                elementCount: form.elements.length,
                fieldNames: formFields.map(field => field.name).filter(Boolean),
                fields: formFields,
            } : null,
        }
    }, {
        captchaSelector: captchaInputSelector,
        authSelector: authCodeSelector,
        turnstileSelector: turnstileInputSelector,
        buttonText: continueButtonText,
    })
}

// 送信や遷移のあとに、送信前スナップショットとの差分が出るまで短時間待つ。
async function waitForPotentialPageChange(page, previousSnapshot, timeoutMs = 10000) {
    try {
        await page.waitForFunction((snapshot, imageSelector, inputSelector, turnstileSelector) => {
            const image = document.querySelector(imageSelector)
            const input = document.querySelector(inputSelector)
            const turnstileInput = document.querySelector(turnstileSelector)
            const bodySnippet = document.body?.innerText?.replace(/\s+/g, ' ').slice(0, 400) ?? ''

            return (
                window.location.href !== snapshot.url
                || document.title !== snapshot.title
                || (image?.src ?? null) !== snapshot.captchaSrc
                || (input?.value ?? '') !== snapshot.captchaValue
                || (turnstileInput?.value ?? '') !== snapshot.turnstileValue
                || bodySnippet !== snapshot.bodySnippet
            )
        }, { timeout: timeoutMs }, previousSnapshot, captchaImageSelector, captchaInputSelector, turnstileInputSelector)
        return true
    } catch {
        // Let the next state check decide whether we progressed.
        return false
    }
}

// 続行ボタンを通常 click し、だめなら DOM 直叩きで submit する。
async function clickContinueButton(page, reason) {
    console.log('Clicking continue button', reason)
    const buttonState = await page.evaluate((text) => {
        const globalSubmitButton = (
            typeof globalThis.submit_button !== 'undefined'
            && globalThis.submit_button
        ) ? globalThis.submit_button : null
        const matchedNode = Array.from(document.querySelectorAll('input[type="submit"], input[type="button"], button, a'))
            .find(node => (node.textContent ?? node.value ?? '').includes(text))
        const submitButton = globalSubmitButton ?? matchedNode ?? null
        return {
            hasGlobalSubmitButton: Boolean(globalSubmitButton),
            hasMatchedNode: Boolean(matchedNode),
            disabled: submitButton && 'disabled' in submitButton ? Boolean(submitButton.disabled) : null,
            className: submitButton?.className ?? null,
        }
    }, continueButtonText)

    if (buttonState.disabled === true) {
        console.log('Skipping locator click because submit button is disabled', buttonState)
    } else {
        try {
            await page.locator(`text=${continueButtonText}`).click({ timeout: 1000 })
            return
        } catch (error) {
            console.log('Locator click failed, falling back to DOM submit', error.message)
        }
    }

    const submitMode = await page.evaluate((text, inputSelector) => {
        const candidates = Array.from(document.querySelectorAll('input[type="submit"], input[type="button"], button, a')) // submit 候補の DOM 一覧
        const target = candidates.find(node => (node.textContent ?? node.value ?? '').includes(text)) // 文言が一致する送信候補
        const globalSubmitButton = (
            typeof globalThis.submit_button !== 'undefined'
            && globalThis.submit_button
        ) ? globalThis.submit_button : null // ページ側が持っているグローバル submit ボタン
        const submitButton = globalSubmitButton ?? target ?? null // 最優先で使う submit 要素
        const form = document.querySelector(inputSelector)?.closest('form') ?? submitButton?.closest('form') ?? document.querySelector('form') // 送信対象 form

        if (submitButton) {
            if ('disabled' in submitButton) {
                submitButton.disabled = false
            }
            if (typeof submitButton.removeAttribute === 'function') {
                submitButton.removeAttribute('disabled')
                submitButton.removeAttribute('aria-disabled')
            }
            submitButton.classList?.remove('disabled', 'is-disabled')
        }

        const isSubmitControl = Boolean(
            submitButton?.matches?.('button:not([type]), button[type="submit"], input[type="submit"], input[type="image"]')
        ) // requestSubmit にそのまま渡せる submit control か
        if (submitButton && typeof submitButton.click === 'function') {
            submitButton.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
            submitButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
            submitButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
            submitButton.click()
            return globalSubmitButton ? 'global-submit-button' : 'matched-node'
        }
        if (form?.requestSubmit && submitButton && isSubmitControl) {
            form.requestSubmit(submitButton)
            return globalSubmitButton ? 'request-submit-global-button' : 'request-submit-matched-button'
        }
        if (form?.requestSubmit) {
            form.requestSubmit()
            return 'request-submit'
        }
        if (form) {
            HTMLFormElement.prototype.submit.call(form)
            return 'native-form-submit'
        }

        return null
    }, continueButtonText, captchaInputSelector)

    if (!submitMode) {
        throw new Error('Could not find any way to submit the renewal form')
    }

    console.log('Continue button fallback used', submitMode)
}

// CAPTCHA 画像を data URL で取り出し、必要なら通常 URL から読み直す。
async function getCaptchaImageBody(page) {
    return page.evaluate(async ({ imageSelector, inputSelector }) => {
        const findImage = () => {
            const directImage = document.querySelector(imageSelector) // data URL 形式で出ている CAPTCHA 画像
            if (directImage?.src) {
                return directImage
            }

            const input = document.querySelector(inputSelector) // 入力欄の近くから画像を探すための基点
            if (!input) {
                return null
            }

            const container = input.closest('form, table, section, article, div') ?? document // 入力欄を含む周辺コンテナ
            return container.querySelector('img')
        }

        const image = findImage() // 実際に使う CAPTCHA 画像要素
        if (!image?.src) {
            return null
        }
        if (image.src.startsWith('data:')) {
            return image.src
        }

        const response = await fetch(image.src, { credentials: 'include' }) // 通常 URL 画像を cookie 付きで取得
        if (!response.ok) {
            throw new Error(`Failed to fetch CAPTCHA image: ${response.status}`)
        }

        const blob = await response.blob() // FileReader で data URL 化するための blob
        return new Promise((resolve, reject) => {
            const reader = new FileReader() // blob を data URL に変換する reader
            reader.onerror = () => reject(new Error('Failed to convert CAPTCHA image to data URL'))
            reader.onloadend = () => resolve(reader.result)
            reader.readAsDataURL(blob)
        })
    }, {
        imageSelector: captchaImageSelector,
        inputSelector: captchaInputSelector,
    })
}

// 認識した CAPTCHA コードを、同名 field を含めてすべての auth_code 入力欄へ反映する。
async function applyCaptchaCode(page, code) {
    await page.evaluate(({ selector, value }) => {
        const fields = Array.from(document.querySelectorAll(selector)) // auth_code を持つ input 一覧
        for (const field of fields) {
            if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) {
                continue
            }
            field.value = value
            field.defaultValue = value
            field.setAttribute('value', value)
            field.dispatchEvent(new Event('input', { bubbles: true }))
            field.dispatchEvent(new Event('change', { bubbles: true }))
        }
    }, {
        selector: authCodeSelector,
        value: code,
    })

    await page.locator(captchaInputSelector).fill(code)
}

// Ethna の CSRF hidden field が空なら、同名 cookie の値で埋められるか試す。
async function syncEthnaCsrf(page) {
    return page.evaluate(() => {
        const fields = Array.from(document.querySelectorAll('[name="ethna_csrf"]')) // Ethna CSRF hidden input 群
        const cookieValue = document.cookie
            .split('; ')
            .find(entry => entry.startsWith('ethna_csrf='))
            ?.slice('ethna_csrf='.length) ?? '' // JS から参照できる ethna_csrf cookie 値

        if (cookieValue) {
            for (const field of fields) {
                if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) {
                    continue
                }
                const decodedValue = decodeURIComponent(cookieValue)
                field.value = decodedValue
                field.defaultValue = decodedValue
                field.setAttribute('value', decodedValue)
                field.dispatchEvent(new Event('input', { bubbles: true }))
                field.dispatchEvent(new Event('change', { bubbles: true }))
            }
        }

        return {
            fieldCount: fields.length,
            fieldLengths: fields.map(field => ('value' in field ? String(field.value ?? '').length : 0)),
            cookieLength: cookieValue.length,
            cookieNames: document.cookie
                .split('; ')
                .filter(Boolean)
                .map(entry => entry.split('=')[0]),
        }
    })
}

// 更新ページで画像 CAPTCHA が出るまで、Turnstile 解決や再送信を挟みながら待つ。
async function waitForRenewalCaptcha(page) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const state = await getRenewalPageState(page) // 各試行時点の更新ページ状態
        console.log('Renewal page state', { attempt, ...state })

        if (state.hasCaptchaImage && state.hasCaptchaInput) {
            return
        }

        if (state.hasTurnstile) {
            await ensureTurnstileReady(page)
            if (!state.hasCaptchaImage && state.hasContinueButton) {
                const previousSnapshot = await getPageChangeSnapshot(page) // 送信前のページ状態
                await clickContinueButton(page, 'advance after Turnstile')
                await waitForPotentialPageChange(page, previousSnapshot)
                continue
            }
        }

        if (state.hasContinueButton && !state.hasCaptchaImage) {
            const previousSnapshot = await getPageChangeSnapshot(page) // 再送信前のページ状態
            await clickContinueButton(page, 'retry until CAPTCHA image is visible')
            await waitForPotentialPageChange(page, previousSnapshot)
            continue
        }

        await setTimeout(3000)
    }

    await saveDebugArtifacts(page, 'renewal-page-missing-captcha')
    throw new Error(`Verification page did not expose the CAPTCHA image: ${JSON.stringify(await getRenewalPageState(page))}`)
}

// 更新送信の POST かどうかを URL と method から判定する。
function isRenewalSubmitRequest(request) {
    return request.method() === 'POST' && request.url().includes('/xapanel/xvps/server/freevps/extend/')
}

// 送信 body をログ用に要約して、どの入力が実際に飛んだかを確認しやすくする。
function summarizePostData(postData) {
    if (!postData) {
        return null
    }

    const params = new URLSearchParams(postData) // application/x-www-form-urlencoded の POST body
    const entries = {}
    for (const [key, value] of params.entries()) {
        entries[key] = {
            length: value.length,
            preview: value.length > 24 ? `${value.slice(0, 12)}...${value.slice(-6)}` : value,
        }
    }

    return {
        keys: Object.keys(entries),
        values: entries,
    }
}

// GitHub Actions のログでオブジェクトが潰れないように JSON 文字列で出力する。
function logJson(label, value) {
    console.log(`${label} ${JSON.stringify(value, null, 2)}`)
}

const browser = await puppeteer.launch({
    headless: browserHeadless,
    defaultViewport: { width: 1080, height: 1024 },
    args,
}) // 自動操作に使う Chromium ブラウザ
const [page] = await browser.pages() // 最初のタブ
const nativeBrowserUserAgent = await browser.userAgent() // 実ブラウザが本来名乗る UA
const effectiveBrowserUserAgent = configuredBrowserUserAgent || nativeBrowserUserAgent // 明示指定がなければ実 UA を使う
const submitTrace = {
    request: null,
    response: null,
    events: [],
} // 更新送信 request/response の観測結果
const turnstileScriptTrace = [] // Turnstile script 本体の取得状況を残す
page.on('request', request => {
    if (request.url().includes('challenges.cloudflare.com/turnstile/')) {
        turnstileScriptTrace.push({
            type: 'request',
            url: request.url(),
            method: request.method(),
            resourceType: request.resourceType(),
        })
    }

    if (!request.url().includes('/xapanel/xvps/server/freevps/extend/')) {
        return
    }

    submitTrace.events.push({
        type: 'request',
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
    })

    if (!isRenewalSubmitRequest(request)) {
        return
    }

    submitTrace.request = {
        url: request.url(),
        method: request.method(),
        headers: {
            'content-type': request.headers()['content-type'] ?? null,
        },
        postData: summarizePostData(request.postData()),
    }
})
page.on('response', response => {
    const request = response.request()
    if (request.url().includes('challenges.cloudflare.com/turnstile/')) {
        Promise.resolve(response.text())
            .then((text) => {
                turnstileScriptTrace.push({
                    type: 'response',
                    url: response.url(),
                    method: request.method(),
                    status: response.status(),
                    resourceType: request.resourceType(),
                    headers: {
                        'content-type': response.headers()['content-type'] ?? null,
                    },
                    bodySnippet: text.replace(/\s+/g, ' ').slice(0, 200),
                })
            })
            .catch((error) => {
                turnstileScriptTrace.push({
                    type: 'response-read-error',
                    url: response.url(),
                    method: request.method(),
                    status: response.status(),
                    resourceType: request.resourceType(),
                    error: String(error),
                })
            })
    }

    if (!request.url().includes('/xapanel/xvps/server/freevps/extend/')) {
        return
    }

    submitTrace.events.push({
        type: 'response',
        url: response.url(),
        method: request.method(),
        status: response.status(),
        resourceType: request.resourceType(),
    })

    if (!isRenewalSubmitRequest(request)) {
        return
    }

    submitTrace.response = {
        url: response.url(),
        status: response.status(),
        headers: {
            location: response.headers().location ?? null,
            'content-type': response.headers()['content-type'] ?? null,
        },
    }
})
page.on('requestfailed', request => {
    if (request.url().includes('challenges.cloudflare.com/turnstile/')) {
        turnstileScriptTrace.push({
            type: 'requestfailed',
            url: request.url(),
            method: request.method(),
            resourceType: request.resourceType(),
            failureText: request.failure()?.errorText ?? null,
        })
    }

    if (!request.url().includes('/xapanel/xvps/server/freevps/extend/')) {
        return
    }

    submitTrace.events.push({
        type: 'requestfailed',
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        failureText: request.failure()?.errorText ?? null,
    })
})
page.on('console', message => {
    if (!['warning', 'error'].includes(message.type())) {
        return
    }

    console.log(`Page console ${message.type()}`, message.text())
})
page.on('pageerror', error => {
    console.log('Page error', error.message)
})
await page.setUserAgent(effectiveBrowserUserAgent)
await page.setExtraHTTPHeaders({ 'accept-language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7' })
console.log('Browser launch configuration', {
    headless: browserHeadless,
    nativeUserAgent: nativeBrowserUserAgent,
    effectiveUserAgent: effectiveBrowserUserAgent,
    configuredPlatform: configuredBrowserPlatform || null,
})
await page.evaluateOnNewDocument((spoofedPlatform) => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    Object.defineProperty(navigator, 'language', { get: () => 'ja-JP' })
    Object.defineProperty(navigator, 'languages', { get: () => ['ja-JP', 'ja', 'en-US', 'en'] })
    if (spoofedPlatform) {
        Object.defineProperty(navigator, 'platform', { get: () => spoofedPlatform })
    }

    // submit 時点の form data を sessionStorage に残し、遷移後にも確認できるようにする。
    const persistSubmitPayload = (form, submitter = null) => {
        try {
            const formData = submitter ? new FormData(form, submitter) : new FormData(form) // submit 時点の送信 payload
            const entries = Array.from(formData.entries()).map(([name, rawValue]) => {
                const value = typeof rawValue === 'string' ? rawValue : `[binary:${rawValue.name ?? 'blob'}]`
                return {
                    name,
                    length: value.length,
                    preview: value.length > 24 ? `${value.slice(0, 12)}...${value.slice(-6)}` : value,
                }
            })

            sessionStorage.setItem('__codexLastSubmitPayload', JSON.stringify({
                action: form.action,
                method: form.method,
                submitterText: submitter ? (submitter.textContent ?? submitter.value ?? submitter.name ?? submitter.id ?? submitter.tagName) : null,
                entries,
            }))
        } catch (error) {
            sessionStorage.setItem('__codexLastSubmitPayload', JSON.stringify({
                error: String(error),
            }))
        }
    }

    document.addEventListener('submit', event => {
        if (!(event.target instanceof HTMLFormElement)) {
            return
        }
        persistSubmitPayload(event.target, event.submitter ?? document.activeElement)
    }, true)

    const originalSubmit = HTMLFormElement.prototype.submit // 元の form.submit
    HTMLFormElement.prototype.submit = function submitWithTrace(...args) {
        persistSubmitPayload(this, document.activeElement)
        return originalSubmit.apply(this, args)
    }

    const originalRequestSubmit = HTMLFormElement.prototype.requestSubmit // 元の form.requestSubmit
    if (typeof originalRequestSubmit === 'function') {
        HTMLFormElement.prototype.requestSubmit = function requestSubmitWithTrace(submitter) {
            persistSubmitPayload(this, submitter ?? document.activeElement)
            return originalRequestSubmit.call(this, submitter)
        }
    }

    // Turnstile の render 引数を横取りして sitekey や callback を保持する。
    const wrapTurnstileApi = (api) => {
        if (!api || typeof api.render !== 'function' || api.__codexHookInstalled) {
            return api
        }

        const originalRender = api.render.bind(api) // 元の render 実装
        api.render = (container, params = {}) => {
            const captured = {
                sitekey: params.sitekey ?? null,
                action: params.action ?? null,
                cData: params.cData ?? params.cdata ?? null,
                chlPageData: params.chlPageData ?? null,
            }
            globalThis.__turnstileRenderParams = captured
            globalThis.__turnstileRenderCalls = [
                ...(Array.isArray(globalThis.__turnstileRenderCalls) ? globalThis.__turnstileRenderCalls : []),
                captured,
            ]
            if (typeof params.callback === 'function') {
                globalThis.__turnstileCallback = params.callback
                globalThis.__turnstileCallbacks = [
                    ...(Array.isArray(globalThis.__turnstileCallbacks) ? globalThis.__turnstileCallbacks : []),
                    params.callback,
                ]
            }
            const widgetId = originalRender(container, params)
            globalThis.__turnstileWidgetIds = [
                ...(Array.isArray(globalThis.__turnstileWidgetIds) ? globalThis.__turnstileWidgetIds : []),
                widgetId,
            ]
            return widgetId
        }
        api.__codexHookInstalled = true
        return api
    }

    let turnstileApi = undefined
    Object.defineProperty(globalThis, 'turnstile', {
        configurable: true,
        enumerable: true,
        get() {
            return turnstileApi
        },
        set(value) {
            turnstileApi = wrapTurnstileApi(value)
        },
    })

    if (globalThis.turnstile) {
        globalThis.turnstile = globalThis.turnstile
    }

    const hookTimer = setInterval(() => {
        if (globalThis.turnstile) {
            globalThis.turnstile = globalThis.turnstile
        }
    }, 50) // Turnstile 読み込み完了まで短周期で hook を試すタイマー
}, configuredBrowserPlatform)
const recorder = await page.screencast({ path: 'recording.webm' }) // 実行中の画面録画

try {
    if (process.env.PROXY_SERVER) {
        const { username, password } = new URL(process.env.PROXY_SERVER) // proxy 認証に使う資格情報
        if (username && password) {
            await page.authenticate({ username, password })
        }
    }

    await page.goto(loginUrl, { waitUntil: 'networkidle2' })
    await page.locator('#memberid').fill(process.env.EMAIL)
    await page.locator('#user_password').fill(process.env.PASSWORD)
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.locator(`text=${loginButtonText}`).click(),
    ])
    await page.locator('a[href^="/xapanel/xvps/server/detail?id="]').click()
    await page.locator('text=更新する').click()
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}),
        page.locator(`text=${continueButtonText}`).click(),
    ])

    await waitForRenewalCaptcha(page)

    const body = await getCaptchaImageBody(page) // 認識 API に渡す CAPTCHA 画像の data URL
    if (!body) {
        await saveDebugArtifacts(page, 'captcha-image-missing')
        throw new Error(`Captcha image is still missing after waiting: ${JSON.stringify(await getRenewalPageState(page))}`)
    }

    const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', {
        method: 'POST',
        body,
        headers: { 'content-type': 'text/plain' },
    }).then(response => response.text()) // 外部 API が返した CAPTCHA 認識結果

    console.log('Captcha recognition result', code.trim())
    await applyCaptchaCode(page, code.trim())
    logJson('Verification diagnostics after captcha fill', await getVerificationDiagnostics(page))
    await ensureTurnstileReady(page)
    logJson('Turnstile script trace', turnstileScriptTrace)
    logJson('Verification diagnostics after Turnstile', await getVerificationDiagnostics(page))
    logJson('Ethna csrf state', await syncEthnaCsrf(page))
    logJson('Verification diagnostics before submit', await getVerificationDiagnostics(page))
    await page.evaluate(() => sessionStorage.removeItem('__codexLastSubmitPayload'))
    const previousSnapshot = await getPageChangeSnapshot(page) // 最終 submit 前のページ状態
    const navigationPromise = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).then(() => ({
        happened: true,
        url: page.url(),
    })).catch(() => null)
    const requestPromise = page.waitForRequest(request => (
        request.method() === 'POST'
        && request.url().includes('/xapanel/xvps/server/freevps/extend/')
    ), { timeout: 15000 }).then(request => ({
        happened: true,
        url: request.url(),
        method: request.method(),
    })).catch(() => null)
    await clickContinueButton(page, 'submit renewal form')
    const pageChanged = await waitForPotentialPageChange(page, previousSnapshot, 15000)
    const submitRequest = await requestPromise
    const navigationResult = await navigationPromise
    const lastSubmitPayload = await page.evaluate(() => {
        const raw = sessionStorage.getItem('__codexLastSubmitPayload')
        return raw ? JSON.parse(raw) : null
    })
    logJson('Submit observation', {
        pageChanged,
        submitRequest,
        trackedRequest: submitTrace.request,
        trackedResponse: submitTrace.response,
        networkEvents: submitTrace.events,
        navigationResult,
        lastSubmitPayload,
    })
    logJson('Post-submit state', await getRenewalPageState(page))
    logJson('Post-submit diagnostics', await getSubmitDiagnostics(page))
    logJson('Verification diagnostics after submit', await getVerificationDiagnostics(page))
} catch (error) {
    await saveDebugArtifacts(page, 'main-error')
    console.error(error)
    process.exitCode = 1
} finally {
    await setTimeout(5000)
    await recorder.stop()
    await browser.close()
}
