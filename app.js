const { Builder, By, until, Capabilities } = require("selenium-webdriver")
const chrome = require("selenium-webdriver/chrome")
const url = require("url")
const fs = require("fs")
const crypto = require("crypto")
const request = require("request")
const path = require("path")
const FormData = require("form-data")
const proxy = require("selenium-webdriver/proxy")
const proxyChain = require("proxy-chain")
const https = require("https")
const http = require("http")
require('console-stamp')(console, {
  format: ':date(yyyy/mm/dd HH:MM:ss.l)'
})
require("dotenv").config()

const extensionId = "caacbgbklghmpodbdafajbgdnegacfmo"
const CRX_URL = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=98.0.4758.102&acceptformat=crx2,crx3&x=id%3D${extensionId}%26uc&nacl_arch=x86-64`
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36"

const USER = process.env.APP_USER || ""
const PASSWORD = process.env.APP_PASS || ""
const ALLOW_DEBUG = !!process.env.DEBUG?.length || false
const EXTENSION_FILENAME = "app.crx"
const PROXY = process.env.PROXY || undefined

// 新增配置常量
const MAX_CONNECTION_RETRIES = parseInt(process.env.MAX_CONNECTION_RETRIES) || 3
const MAX_FLOW_RETRIES = parseInt(process.env.MAX_FLOW_RETRIES) || 2
const IP_REPORT_INTERVAL = parseInt(process.env.IP_REPORT_INTERVAL) || 300000 // 5分钟
const CONNECTION_RETRY_DELAY = parseInt(process.env.CONNECTION_RETRY_DELAY) || 10000 // 10秒
const PROXY_CHECK_INTERVAL = parseInt(process.env.PROXY_CHECK_INTERVAL) || 1800000 // 30分钟
// const CONNECTION_CHECK_INTERVAL = parseInt(process.env.CONNECTION_CHECK_INTERVAL) || 300000 // 5分钟 - 已移除
const MAX_TOTAL_FAILURES = parseInt(process.env.MAX_TOTAL_FAILURES) || 10 // 总失败次数上限

// 全局变量
let cachedProxyIP = null
let ipReportTimer = null
let proxyCheckTimer = null
let connectionCheckTimer = null
let globalDriver = null
let totalFailureCount = 0 // 总失败计数器

console.log("-> Starting...")
console.log("-> User:", USER)
console.log("-> Pass:", PASSWORD)
console.log("-> Proxy:", PROXY)
console.log("-> Debug:", ALLOW_DEBUG)

if (!USER || !PASSWORD) {
  console.error("Please set APP_USER and APP_PASS env variables")
  process.exit()
}

if (ALLOW_DEBUG) {
  console.log(
    "-> Debugging is enabled! This will generate a screenshot and console logs on error!"
  )
}

async function downloadExtension(extensionId) {
  const url = CRX_URL.replace(extensionId, extensionId)
  const headers = { "User-Agent": USER_AGENT }

  console.log("-> Downloading extension from:", url)

  // if file exists and modify time is less than 1 day, skip download
  if (fs.existsSync(EXTENSION_FILENAME) && fs.statSync(EXTENSION_FILENAME).mtime > Date.now() - 86400000) {
    console.log("-> Extension already downloaded! skip download...")
    return
  }

  return new Promise((resolve, reject) => {
    // 使用本地网络下载扩展，不使用代理
    request({ url, headers, encoding: null, proxy: false }, (error, response, body) => {
      if (error) {
        console.error("Error downloading extension:", error)
        return reject(error)
      }
      fs.writeFileSync(EXTENSION_FILENAME, body)
      if (ALLOW_DEBUG) {
        const md5 = crypto.createHash("md5").update(body).digest("hex")
        console.log("-> Extension MD5: " + md5)
      }
      resolve()
    })
  })
}

async function takeScreenshot(driver, filename) {
  // if ALLOW_DEBUG is set, taking screenshot
  if (!ALLOW_DEBUG) {
    return
  }

  const data = await driver.takeScreenshot()
  fs.writeFileSync(filename, Buffer.from(data, "base64"))
}

async function generateErrorReport(driver) {
  //write dom
  const dom = await driver.findElement(By.css("html")).getAttribute("outerHTML")
  fs.writeFileSync("error.html", dom)

  await takeScreenshot(driver, "error.png")

  const logs = await driver.manage().logs().get("browser")
  fs.writeFileSync(
    "error.log",
    logs.map((log) => `${log.level.name}: ${log.message}`).join("\n")
  )
}

async function getDriverOptions() {
  const options = new chrome.Options()

  options.addArguments("--headless")
  options.addArguments("--single-process")
  options.addArguments(`user-agent=${USER_AGENT}`)
  options.addArguments("--remote-allow-origins=*")
  options.addArguments("--disable-dev-shm-usage")
  // options.addArguments("--incognito")
  options.addArguments('enable-automation')
  options.addArguments("--window-size=1920,1080")
  options.addArguments("--start-maximized")
  options.addArguments("--disable-renderer-backgrounding")
  options.addArguments("--disable-background-timer-throttling")
  options.addArguments("--disable-backgrounding-occluded-windows")
  options.addArguments("--disable-low-res-tiling")
  options.addArguments("--disable-client-side-phishing-detection")
  options.addArguments("--disable-crash-reporter")
  options.addArguments("--disable-oopr-debug-crash-dump")
  options.addArguments("--disable-infobars")
  options.addArguments("--dns-prefetch-disable")
  options.addArguments("--disable-crash-reporter")
  options.addArguments("--disable-in-process-stack-traces")
  options.addArguments("--disable-popup-blocking")
  options.addArguments("--disable-gpu")
  options.addArguments("--disable-web-security")
  options.addArguments("--disable-default-apps")
  options.addArguments("--ignore-certificate-errors")
  options.addArguments("--ignore-ssl-errors")
  options.addArguments("--no-sandbox")
  options.addArguments("--no-crash-upload")
  options.addArguments("--no-zygote")
  options.addArguments("--no-first-run")
  options.addArguments("--no-default-browser-check")
  options.addArguments("--remote-allow-origins=*")
  options.addArguments("--allow-running-insecure-content")
  options.addArguments("--enable-unsafe-swiftshader")

  // 保持浏览器默认设置，确保网站功能正常
  // 移除了所有内容限制，让网站正常运行

  if (!ALLOW_DEBUG) {
    // options.addArguments("--blink-settings=imagesEnabled=false")
  }

  if (PROXY) {
    console.log("-> Setting up proxy...", PROXY)

    let proxyUrl = PROXY

    // if no scheme, add http://
    if (!proxyUrl.includes("://")) {
      proxyUrl = `http://${proxyUrl}`
    }

    const newProxyUrl = await proxyChain.anonymizeProxy(proxyUrl)

    console.log("-> New proxy URL:", newProxyUrl)

    options.setProxy(
      proxy.manual({
        http: newProxyUrl,
        https: newProxyUrl,
      })
    )
    const url = new URL(newProxyUrl)
    console.log("-> Proxy host:", url.hostname)
    console.log("-> Proxy port:", url.port)
    options.addArguments(`--proxy-server=socks5://${url.hostname}:${url.port}`)
    console.log("-> Setting up proxy done!")
  } else {
    console.log("-> No proxy set!")
  }

  return options
}

// 检测代理类型并使用相应的检查方法
async function checkProxyWithHTTP(proxyUrl) {
  return new Promise((resolve, reject) => {
    console.log(`-> 🔍 使用request库检查代理: ${proxyUrl}`)

    // 检测代理类型
    const isSocks = proxyUrl.toLowerCase().includes('socks')
    const testUrls = [
      'http://httpbin.org/ip',  // 先尝试HTTP，对SOCKS更友好
      'https://api.ipify.org?format=json',
      'https://httpbin.org/ip'
    ]

    let attempts = 0
    const maxAttempts = testUrls.length

    function tryUrl(urlIndex) {
      if (urlIndex >= maxAttempts) {
        reject(new Error('所有URL尝试均失败'))
        return
      }

      const testUrl = testUrls[urlIndex]
      console.log(`-> 📡 尝试${isSocks ? 'SOCKS' : 'HTTP'}代理访问: ${testUrl}`)

      const options = {
        url: testUrl,
        proxy: proxyUrl,
        timeout: 15000,
        headers: {
          'User-Agent': USER_AGENT
        },
        json: true,
        // 对于SOCKS代理，禁用SSL验证可能有帮助
        strictSSL: false,
        // 增加连接选项
        pool: {
          maxSockets: 1
        }
      }

      request(options, (error, response, body) => {
        if (error) {
          console.log(`-> ⚠️  ${testUrl} 失败: ${error.message}`)
          // 尝试下一个URL
          tryUrl(urlIndex + 1)
          return
        }

        if (response.statusCode === 200 && body) {
          let ipInfo = null

          // 处理不同的响应格式
          if (typeof body === 'object') {
            // httpbin.org/ip 格式: {"origin": "1.2.3.4"}
            if (body.origin) {
              ipInfo = body.origin
            }
            // api.ipify.org 格式: {"ip": "1.2.3.4"}
            else if (body.ip) {
              ipInfo = body.ip
            }
          } else if (typeof body === 'string') {
            // 尝试解析JSON字符串
            try {
              const parsed = JSON.parse(body)
              if (parsed.origin) ipInfo = parsed.origin
              else if (parsed.ip) ipInfo = parsed.ip
            } catch (e) {
              // 如果不是JSON，直接从字符串中提取IP
              const ipMatch = body.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/)
              if (ipMatch) {
                ipInfo = ipMatch[0]
              }
            }
          }

          if (ipInfo) {
            console.log(`-> ✅ ${isSocks ? 'SOCKS' : 'HTTP'}代理检查成功: ${ipInfo}`)
            resolve(ipInfo)
          } else {
            console.log(`-> ⚠️  ${testUrl} 响应格式异常:`, typeof body === 'string' ? body.substring(0, 100) : body)
            tryUrl(urlIndex + 1)
          }
        } else {
          console.log(`-> ⚠️  ${testUrl} HTTP错误: ${response.statusCode}`)
          tryUrl(urlIndex + 1)
        }
      })
    }

    tryUrl(0)
  })
}

async function getProxyIpInfo(driver, proxyUrl, retryCount = 0) {
  const maxRetries = 3

  console.log(`-> 🔍 强制代理IP检测 (重试 ${retryCount}/${maxRetries}): ${proxyUrl}`)

  // 首先尝试使用HTTP请求检查（类似curl）
  try {
    const ipInfo = await checkProxyWithHTTP(proxyUrl)
    if (ipInfo) {
      console.log("-> ✅ 代理IP检测成功:", ipInfo)
      cachedProxyIP = ipInfo
      return ipInfo
    }
  } catch (error) {
    console.log(`-> ⚠️  HTTP代理检查失败: ${error.message}`)
  }

  // 如果HTTP检查失败，回退到浏览器检查
  const urls = ["https://myip.ipip.net", "https://httpbin.org/ip", "https://api.ipify.org"]

  for (let urlIndex = 0; urlIndex < urls.length; urlIndex++) {
    const url = urls[urlIndex]
    try {
      console.log(`-> 📡 浏览器检查: ${url}`)
      await driver.get(url)
      await driver.wait(until.elementLocated(By.css("body")), 20000)
      const pageText = await driver.findElement(By.css("body")).getText()

      if (pageText && pageText.trim().length > 0) {
        const ipInfo = pageText.trim()

        // 验证IP格式
        const ipPattern = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/
        if (ipPattern.test(ipInfo)) {
          console.log("-> ✅ 浏览器代理检查成功:", ipInfo)
          cachedProxyIP = ipInfo
          return ipInfo
        } else {
          console.log("-> ⚠️  返回内容不包含有效IP地址:", ipInfo)
          continue
        }
      }
    } catch (error) {
      console.log(`-> ❌ 浏览器检查 ${url} 失败:`, error.message)
      continue
    }
  }

  // 所有检查都失败，尝试重试
  if (retryCount < maxRetries) {
    const delay = (retryCount + 1) * 3000 // 3秒, 6秒, 9秒
    console.log(`-> 🔄 ${delay/1000}秒后重试代理IP检测...`)
    await new Promise(resolve => setTimeout(resolve, delay))
    return await getProxyIpInfo(driver, proxyUrl, retryCount + 1)
  }

  console.log("-> ❌ 所有代理IP检测尝试均失败")
  console.log("-> 💡 可能的原因:")
  console.log("   1. 代理服务器不可用或配置错误")
  console.log("   2. 代理服务器不支持HTTPS连接")
  console.log("   3. 网络连接问题")
  console.log(`   4. 请手动测试: curl -vv -x ${proxyUrl} https://httpbin.org/ip`)

  throw new Error(`代理IP检测失败: 无法通过代理 ${proxyUrl} 获取IP信息`)
}

// 检测Unsupported元素
async function checkUnsupportedElement(driver) {
  try {
    const unsupportedElement = await driver.findElement(
      By.xpath('//*[contains(text(), "Unsupported")]')
    )
    if (unsupportedElement) {
      console.log("-> ❌ 检测到Unsupported元素，当前地区不支持服务")
      console.log("-> 🛑 程序将彻底停止，阻止任何重启")

      // 创建标记文件防止重启
      createUnsupportedFlag()

      await generateErrorReport(driver)
      await driver.quit()

      // 停止所有定时器
      stopIPReporting()
      stopProxyHealthCheck()
      stopConnectionStatusCheck()

      // 强制停止PM2进程
      console.log("-> 💡 提示：删除 .unsupported_region 文件后可重新尝试")
      console.log("-> 🔄 正在强制停止PM2进程...")

      // 尝试停止PM2进程
      try {
        const { exec } = require('child_process')
        exec('pm2 stop gradient-bot', (error) => {
          if (error) {
            console.log("-> ⚠️  无法停止PM2进程，使用强制退出")
          } else {
            console.log("-> ✅ PM2进程已停止")
          }
          // 无论如何都要退出
          process.exit(0)
        })

        // 5秒后强制退出
        setTimeout(() => {
          console.log("-> 🔄 强制退出程序")
          process.exit(0)
        }, 5000)

      } catch (error) {
        console.log("-> ⚠️  无法执行PM2命令，直接退出")
        process.exit(0)
      }
    }
  } catch (error) {
    // 没有找到Unsupported元素，继续执行
  }
}

// 定期报告代理IP
function startIPReporting() {
  if (!PROXY || !cachedProxyIP) return

  ipReportTimer = setInterval(() => {
    console.log(`-> 📡 当前代理IP: ${cachedProxyIP}`)
  }, IP_REPORT_INTERVAL)
}

// 停止IP报告
function stopIPReporting() {
  if (ipReportTimer) {
    clearInterval(ipReportTimer)
    ipReportTimer = null
  }
}

// 定期检查代理状态
function startProxyHealthCheck() {
  if (!PROXY || !globalDriver) return

  console.log(`-> 🔄 启动代理健康检查，每${PROXY_CHECK_INTERVAL/60000}分钟检查一次`)

  proxyCheckTimer = setInterval(async () => {
    try {
      console.log("-> 🔍 开始定期代理健康检查...")
      const oldIP = cachedProxyIP
      await getProxyIpInfo(globalDriver, PROXY)

      if (cachedProxyIP !== oldIP && oldIP) {
        console.log(`-> ⚠️  代理IP发生变化: ${oldIP} → ${cachedProxyIP}`)
      }

      console.log("-> ✅ 代理健康检查通过")
    } catch (error) {
      console.log("-> ❌ 代理健康检查失败:", error.message)
      console.log("-> 🔄 代理可能已断开，将触发重试机制...")

      // 记录失败
      recordFailureAndCheckRestart("代理健康检查失败")

      // 停止所有定时器
      stopIPReporting()
      stopProxyHealthCheck()

      // 抛出错误，触发流程重试
      throw new Error("代理健康检查失败，需要重启流程")
    }
  }, PROXY_CHECK_INTERVAL)
}

// 停止代理健康检查
function stopProxyHealthCheck() {
  if (proxyCheckTimer) {
    clearInterval(proxyCheckTimer)
    proxyCheckTimer = null
    console.log("-> 🛑 代理健康检查已停止")
  }
}

// 连接状态检查系统已移除 - 不再需要定期刷新页面检查

// 停止连接状态检查（保留函数以兼容现有调用）
function stopConnectionStatusCheck() {
  // 已移除连接状态检查功能
}

// 记录失败并检查是否需要重启进程
function recordFailureAndCheckRestart(errorType = "未知错误") {
  totalFailureCount++
  console.log(`-> ⚠️  记录失败事件: ${errorType} (总计: ${totalFailureCount}/${MAX_TOTAL_FAILURES})`)

  if (totalFailureCount >= MAX_TOTAL_FAILURES) {
    console.log("-> 🚨 连接失败次数已达上限，准备重启进程...")
    console.log(`-> 📊 失败统计: 总计${totalFailureCount}次失败`)
    console.log("-> 🔄 即将重启进程以恢复服务...")

    // 清理所有资源
    stopIPReporting()
    stopProxyHealthCheck()
    stopConnectionStatusCheck()

    if (globalDriver) {
      try {
        globalDriver.quit()
      } catch (e) {
        console.log("-> ⚠️  关闭driver时出错:", e.message)
      }
    }

    // 使用特殊退出码3表示需要重启
    console.log("-> 💡 提示：PM2将自动重启进程")
    process.exit(3)
  }
}

// 重置失败计数器（成功时调用）
function resetFailureCount() {
  if (totalFailureCount > 0) {
    console.log(`-> ✅ 重置失败计数器 (之前: ${totalFailureCount}次失败)`)
    totalFailureCount = 0
  }
}

// 检测连接状态并重试
async function checkConnectionAndRetry(driver, retryCount = 0) {
  try {
    // 检查Unsupported元素
    await checkUnsupportedElement(driver)

    // 检查连接状态
    const supportStatus = await driver
      .findElement(By.css(".absolute.mt-3.right-0.z-10"))
      .getText()

    console.log(`-> 📊 连接状态检查 (重试 ${retryCount}/${MAX_CONNECTION_RETRIES}): ${supportStatus}`)

    if (supportStatus.includes("Disconnected") || supportStatus.includes("disconnect")) {
      if (retryCount < MAX_CONNECTION_RETRIES) {
        console.log(`-> ⚠️  检测到连接断开，${CONNECTION_RETRY_DELAY/1000}秒后重试连接...`)
        await new Promise(resolve => setTimeout(resolve, CONNECTION_RETRY_DELAY))

        // 刷新页面重试连接
        await driver.navigate().refresh()
        await driver.sleep(5000)

        return await checkConnectionAndRetry(driver, retryCount + 1)
      } else {
        console.log("-> ❌ 连接重试次数已达上限，抛出错误以触发流程重试")
        recordFailureAndCheckRestart("连接重试失败")
        throw new Error("Connection failed after maximum retries")
      }
    }

    // 连接正常，重置失败计数
    resetFailureCount()
    return supportStatus
  } catch (error) {
    if (retryCount < MAX_CONNECTION_RETRIES) {
      console.log(`-> ⚠️  连接检查失败，${CONNECTION_RETRY_DELAY/1000}秒后重试...`)
      await new Promise(resolve => setTimeout(resolve, CONNECTION_RETRY_DELAY))
      return await checkConnectionAndRetry(driver, retryCount + 1)
    } else {
      throw error
    }
  }
}

// 主要执行函数，支持重试
async function runMainFlow(flowRetryCount = 0) {
  console.log(`-> 🚀 开始执行主流程 (流程重试 ${flowRetryCount}/${MAX_FLOW_RETRIES})`)

  await downloadExtension(extensionId)

  const options = await getDriverOptions()
  options.addExtensions(path.resolve(__dirname, EXTENSION_FILENAME))
  console.log(`-> Extension added! ${EXTENSION_FILENAME}`)

  // enable debug
  if (ALLOW_DEBUG) {
    options.addArguments("--enable-logging")
    options.addArguments("--v=1")
  }

  let driver
  try {
    console.log("-> Starting browser...")

    driver = await new Builder()
      .forBrowser("chrome")
      .setChromeOptions(options)
      .build()

    console.log("-> Browser started!")

    // 保存driver引用供代理健康检查使用
    globalDriver = driver

    if (PROXY) {
      try {
        await getProxyIpInfo(driver, PROXY)
        // 启动IP报告
        startIPReporting()
        // 启动代理健康检查
        startProxyHealthCheck()
        // 重置失败计数器
        resetFailureCount()
        console.log("-> ✅ 代理IP检查成功，已启动定期报告和健康检查")
      } catch (error) {
        console.log("-> ❌ 代理IP检查失败，这是代理可用性检测的重要一环")
        console.log(`-> 💡 请检查代理连接: curl -vv -x ${PROXY} https://myip.ipip.net`)
        console.log("-> � 程序无法在代理不可用的情况下正常工作")
        recordFailureAndCheckRestart("代理IP检测失败")
        throw new Error(`代理IP检测失败，请检查代理配置: ${PROXY}`)
      }
    } else {
      console.log("-> ℹ️  未配置代理，将使用本地网络")
    }

    console.log("-> Started! Logging in https://app.gradient.network/...")
    await driver.get("https://app.gradient.network/")

    const emailInput = By.css('[placeholder="Enter Email"]')
    const passwordInput = By.css('[type="password"]')
    const loginButton = By.css("button")

    await driver.wait(until.elementLocated(emailInput), 30000)
    await driver.wait(until.elementLocated(passwordInput), 30000)
    await driver.wait(until.elementLocated(loginButton), 30000)

    await driver.findElement(emailInput).sendKeys(USER)
    await driver.findElement(passwordInput).sendKeys(PASSWORD)
    await driver.findElement(loginButton).click()

    // wait until find <a href="/dashboard/setting">
    await driver.wait(until.elementLocated(By.css('a[href="/dashboard/setting"]')), 30000)

    console.log("-> Logged in! Waiting for open extension...")

    // 截图登录状态
    takeScreenshot(driver, "logined.png")

    await driver.get(`chrome-extension://${extensionId}/popup.html`)

    console.log("-> Extension opened!")

    // 等待页面加载完成，增加更长的等待时间
    await driver.sleep(10000)

    // 尝试多种选择器来找到Status元素
    let statusFound = false
    const selectors = [
      '//*[contains(text(), "Status")]',
      '//div[contains(@class, "Helveticae") and contains(text(), "Status")]',
      '//div[contains(@class, "helveticae") and contains(text(), "Status")]',
      '//*[text()="Status"]'
    ]

    for (const selector of selectors) {
      try {
        console.log(`-> Trying selector: ${selector}`)
        await driver.wait(until.elementLocated(By.xpath(selector)), 15000)
        console.log(`-> Found Status element with selector: ${selector}`)
        statusFound = true
        break
      } catch (error) {
        console.log(`-> Selector failed: ${selector}`)
        continue
      }
    }

    if (!statusFound) {
      console.log("-> Could not find Status element, taking screenshot for debugging...")
      await takeScreenshot(driver, "debug-no-status.png")

      // 保存页面HTML用于调试
      const pageSource = await driver.getPageSource()
      fs.writeFileSync("debug-page-source.html", pageSource)
      console.log("-> Page source saved to debug-page-source.html")

      throw new Error("Could not find Status element with any selector")
    }

    console.log("-> Extension loaded!")

    // if there is a page with a button "I got it", click it
    try {
      const gotItButton = await driver.findElement(
        By.xpath('//button[contains(text(), "I got it")]')
      )
      await gotItButton.click()
      console.log('-> "I got it" button clicked!')
    } catch (error) {
      // save rendered dom to file
      const dom = await driver
        .findElement(By.css("html"))
        .getAttribute("outerHTML")
      fs.writeFileSync("dom.html", dom)
      console.error('-> No "I got it" button found!(skip)')
    }

    // if found a div include text "Sorry, Gradient is not yet available in your region. ", then exit
    try {
      const notAvailable = await driver.findElement(
        By.xpath(
          '//*[contains(text(), "Sorry, Gradient is not yet available in your region.")]'
        )
      )
      console.log("-> Sorry, Gradient is not yet available in your region. ")
      await driver.quit()
      process.exit(1)
    } catch (error) {
      console.log("-> Gradient is available in your region. ")
    }

    // 使用新的连接检查和重试机制
    const supportStatus = await checkConnectionAndRetry(driver)

    if (ALLOW_DEBUG) {
      const dom = await driver
        .findElement(By.css("html"))
        .getAttribute("outerHTML")
      fs.writeFileSync("dom.html", dom)
      await takeScreenshot(driver, "status.png")
    }

    console.log("-> Status:", supportStatus)

    console.log("-> Connected! Starting rolling...")

    // 截图链接状态
    takeScreenshot(driver, "connected.png")

    console.log({
      support_status: supportStatus,
    })

    console.log("-> Lunched!")

    // keep the process running with enhanced monitoring
    setInterval(async () => {
      try {
        const title = await driver.getTitle()
        console.log(`-> [${USER}] Running...`, title)

        // 检查Unsupported元素
        await checkUnsupportedElement(driver)

      } catch (error) {
        console.error("-> ⚠️  监控循环中发生错误:", error.message)
        // 如果监控失败，可能需要重启流程
        throw error
      }
    }, 30000)
  } catch (error) {
    console.error("-> ❌ 主流程发生错误:", error.message)
    console.error(error.stack)

    // 记录失败
    recordFailureAndCheckRestart("主流程错误")

    if (driver) {
      await generateErrorReport(driver)
      console.error("-> Error report generated!")
      try {
        console.error(fs.readFileSync("error.log").toString())
      } catch (e) {
        console.error("-> 无法读取错误日志文件")
      }
      await driver.quit()
    }

    // 停止所有定时器
    stopIPReporting()
    stopProxyHealthCheck()
    stopConnectionStatusCheck()

    // 检查是否需要重试流程
    if (flowRetryCount < MAX_FLOW_RETRIES) {
      console.log(`-> 🔄 ${CONNECTION_RETRY_DELAY/1000}秒后重试整个流程...`)
      await new Promise(resolve => setTimeout(resolve, CONNECTION_RETRY_DELAY))
      return await runMainFlow(flowRetryCount + 1)
    } else {
      console.error("-> ❌ 流程重试次数已达上限，程序退出")
      process.exit(1)
    }
  }
}

// 检查是否存在Unsupported标记文件
function checkUnsupportedFlag() {
  const flagFile = path.join(__dirname, '.unsupported_region')
  if (fs.existsSync(flagFile)) {
    console.log("-> 🛑 检测到Unsupported地区标记文件")
    console.log("-> 💡 当前地区不支持服务，程序将不会启动")
    console.log("-> 🗑️  如需重新尝试，请删除文件:", flagFile)
    process.exit(0) // 正常退出，不重启
  }
}

// 创建Unsupported标记文件
function createUnsupportedFlag() {
  const flagFile = path.join(__dirname, '.unsupported_region')
  const timestamp = new Date().toISOString()
  const content = `Unsupported region detected at: ${timestamp}\nTo retry, delete this file.`

  try {
    fs.writeFileSync(flagFile, content)
    console.log("-> 📝 已创建Unsupported地区标记文件:", flagFile)
  } catch (error) {
    console.log("-> ⚠️  无法创建标记文件:", error.message)
  }
}

// 启动主流程
(async () => {
  // 首先检查Unsupported标记
  checkUnsupportedFlag()

  try {
    await runMainFlow()
  } catch (error) {
    console.error("-> ❌ 程序最终失败:", error.message)
    process.exit(1)
  }
})()
