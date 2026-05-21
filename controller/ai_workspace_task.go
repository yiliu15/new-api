package controller

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/system_setting"

	"github.com/gin-gonic/gin"
)

const (
	aiWorkspaceTaskTTL       = 30 * time.Minute
	aiWorkspaceTaskTimeout   = 10 * time.Minute
	aiWorkspaceMaxImageBytes = 10 << 20
)

type aiWorkspaceTaskStatus string

const (
	aiWorkspaceTaskPending  aiWorkspaceTaskStatus = "pending"
	aiWorkspaceTaskRunning  aiWorkspaceTaskStatus = "running"
	aiWorkspaceTaskSuccess  aiWorkspaceTaskStatus = "success"
	aiWorkspaceTaskFailed   aiWorkspaceTaskStatus = "failed"
	aiWorkspaceTaskCanceled aiWorkspaceTaskStatus = "canceled"
)

type aiWorkspaceImageTask struct {
	ID        string                `json:"id"`
	UserID    int                   `json:"-"`
	Type      string                `json:"type"`
	Status    aiWorkspaceTaskStatus `json:"status"`
	Images    []string              `json:"images,omitempty"`
	Error     string                `json:"error,omitempty"`
	CreatedAt time.Time             `json:"created_at"`
	ExpiresAt time.Time             `json:"expires_at"`
	cancel    context.CancelFunc
}

type aiWorkspaceTaskStore struct {
	sync.Mutex
	tasks        map[string]*aiWorkspaceImageTask
	activeByUser map[int]string
}

var aiWorkspaceTasks = &aiWorkspaceTaskStore{
	tasks:        map[string]*aiWorkspaceImageTask{},
	activeByUser: map[int]string{},
}

func init() {
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			aiWorkspaceTasks.cleanupExpired()
		}
	}()
}

type aiWorkspaceCreateTaskRequest struct {
	Type   string `json:"type"`
	APIKey string `json:"api_key"`
	Model  string `json:"model"`
	Prompt string `json:"prompt"`
	Size   string `json:"size"`
}

type aiWorkspaceImageData struct {
	URL     string `json:"url"`
	B64JSON string `json:"b64_json"`
}

type aiWorkspaceImageResponse struct {
	Data []aiWorkspaceImageData `json:"data"`
}

func CreateAIWorkspaceImageTask(c *gin.Context) {
	userID := c.GetInt("id")
	if !canUseAIWorkspace(userID, c.GetInt("role")) {
		common.ApiErrorMsg(c, "AI Workspace is disabled or your account does not have permission to use it.")
		return
	}

	aiWorkspaceTasks.cleanupExpired()
	if task := aiWorkspaceTasks.activeTaskForUser(userID); task != nil {
		common.ApiErrorMsg(c, "Another image task is already running.")
		return
	}

	request, image, err := parseAIWorkspaceTaskRequest(c)
	if err != nil {
		common.ApiError(c, err)
		return
	}

	taskType := strings.TrimSpace(request.Type)
	if taskType != "generation" && taskType != "edit" {
		common.ApiErrorMsg(c, "Invalid image task type.")
		return
	}
	if strings.TrimSpace(request.APIKey) == "" {
		common.ApiErrorMsg(c, "API key is required.")
		return
	}
	if strings.TrimSpace(request.Model) == "" {
		common.ApiErrorMsg(c, "Model is required.")
		return
	}
	if strings.TrimSpace(request.Prompt) == "" {
		common.ApiErrorMsg(c, "Prompt is required.")
		return
	}
	if request.Size == "" {
		request.Size = "auto"
	}
	if taskType == "edit" && image == nil {
		common.ApiErrorMsg(c, "Image is required.")
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	now := time.Now()
	task := &aiWorkspaceImageTask{
		ID:        common.GetUUID(),
		UserID:    userID,
		Type:      taskType,
		Status:    aiWorkspaceTaskPending,
		CreatedAt: now,
		ExpiresAt: now.Add(aiWorkspaceTaskTTL),
		cancel:    cancel,
	}
	aiWorkspaceTasks.add(task)

	go runAIWorkspaceImageTask(ctx, task.ID, request, image, resolveAIWorkspaceRelayBaseURL(c))

	common.ApiSuccess(c, task.safeCopy())
}

func GetAIWorkspaceImageTask(c *gin.Context) {
	userID := c.GetInt("id")
	task := aiWorkspaceTasks.get(c.Param("id"))
	if task == nil || task.UserID != userID {
		common.ApiErrorMsg(c, "Task not found.")
		return
	}
	common.ApiSuccess(c, task.safeCopy())
}

func CancelAIWorkspaceImageTask(c *gin.Context) {
	userID := c.GetInt("id")
	task := aiWorkspaceTasks.cancel(c.Param("id"), userID)
	if task == nil {
		common.ApiErrorMsg(c, "Task not found.")
		return
	}
	common.ApiSuccess(c, task.safeCopy())
}

func canUseAIWorkspace(userID int, role int) bool {
	common.OptionMapRWMutex.RLock()
	enabled := common.OptionMap["AIWorkspaceEnabled"] == "true"
	common.OptionMapRWMutex.RUnlock()
	if !enabled {
		return false
	}
	if role >= common.RoleAdminUser {
		return true
	}
	user, err := model.GetUserById(userID, false)
	return err == nil && user.AIWorkspaceEnabled
}

func parseAIWorkspaceTaskRequest(c *gin.Context) (aiWorkspaceCreateTaskRequest, *aiWorkspaceTaskImage, error) {
	contentType := c.GetHeader("Content-Type")
	if strings.HasPrefix(contentType, "application/json") {
		var request aiWorkspaceCreateTaskRequest
		if err := c.ShouldBindJSON(&request); err != nil {
			return request, nil, err
		}
		return request, nil, nil
	}

	if err := c.Request.ParseMultipartForm(aiWorkspaceMaxImageBytes); err != nil {
		return aiWorkspaceCreateTaskRequest{}, nil, err
	}
	request := aiWorkspaceCreateTaskRequest{
		Type:   c.PostForm("type"),
		APIKey: c.PostForm("api_key"),
		Model:  c.PostForm("model"),
		Prompt: c.PostForm("prompt"),
		Size:   c.PostForm("size"),
	}
	file, header, err := c.Request.FormFile("image")
	if err != nil {
		if errors.Is(err, http.ErrMissingFile) {
			return request, nil, nil
		}
		return request, nil, err
	}
	defer file.Close()

	limited := io.LimitReader(file, aiWorkspaceMaxImageBytes+1)
	content, err := io.ReadAll(limited)
	if err != nil {
		return request, nil, err
	}
	if len(content) > aiWorkspaceMaxImageBytes {
		return request, nil, fmt.Errorf("image size must be under 10MB")
	}
	contentType = header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = http.DetectContentType(content)
	}
	return request, &aiWorkspaceTaskImage{
		Filename:    header.Filename,
		ContentType: contentType,
		Content:     content,
	}, nil
}

type aiWorkspaceTaskImage struct {
	Filename    string
	ContentType string
	Content     []byte
}

func runAIWorkspaceImageTask(ctx context.Context, taskID string, request aiWorkspaceCreateTaskRequest, image *aiWorkspaceTaskImage, relayBaseURL string) {
	aiWorkspaceTasks.markRunning(taskID)

	ctx, cancel := context.WithTimeout(ctx, aiWorkspaceTaskTimeout)
	defer cancel()

	images, err := callAIWorkspaceImageRelay(ctx, request, image, relayBaseURL)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			aiWorkspaceTasks.markCanceled(taskID)
			return
		}
		aiWorkspaceTasks.markFailed(taskID, err.Error())
		return
	}
	aiWorkspaceTasks.markSuccess(taskID, images)
}

func callAIWorkspaceImageRelay(ctx context.Context, request aiWorkspaceCreateTaskRequest, image *aiWorkspaceTaskImage, relayBaseURL string) ([]string, error) {
	var httpRequest *http.Request
	var err error

	if request.Type == "edit" {
		body := &bytes.Buffer{}
		writer := multipart.NewWriter(body)
		_ = writer.WriteField("model", strings.TrimSpace(request.Model))
		_ = writer.WriteField("prompt", request.Prompt)
		_ = writer.WriteField("n", "1")
		_ = writer.WriteField("size", request.Size)
		partHeader := make(textproto.MIMEHeader)
		partHeader.Set("Content-Disposition", fmt.Sprintf(`form-data; name="image"; filename="%s"`, escapeQuotes(image.Filename)))
		partHeader.Set("Content-Type", image.ContentType)
		part, err := writer.CreatePart(partHeader)
		if err != nil {
			return nil, err
		}
		if _, err = part.Write(image.Content); err != nil {
			return nil, err
		}
		if err = writer.Close(); err != nil {
			return nil, err
		}
		httpRequest, err = http.NewRequestWithContext(ctx, http.MethodPost, relayBaseURL+"/v1/images/edits", body)
		if err != nil {
			return nil, err
		}
		httpRequest.Header.Set("Content-Type", writer.FormDataContentType())
	} else {
		body, err := json.Marshal(gin.H{
			"model":  strings.TrimSpace(request.Model),
			"prompt": request.Prompt,
			"n":      1,
			"size":   request.Size,
		})
		if err != nil {
			return nil, err
		}
		httpRequest, err = http.NewRequestWithContext(ctx, http.MethodPost, relayBaseURL+"/v1/images/generations", bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		httpRequest.Header.Set("Content-Type", "application/json")
	}

	httpRequest.Header.Set("Authorization", "Bearer "+strings.TrimSpace(request.APIKey))

	client := &http.Client{Timeout: aiWorkspaceTaskTimeout}
	response, err := client.Do(httpRequest)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	body, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, errors.New(string(body))
	}

	var imageResponse aiWorkspaceImageResponse
	if err := json.Unmarshal(body, &imageResponse); err != nil {
		return nil, err
	}
	images := make([]string, 0, len(imageResponse.Data))
	for _, item := range imageResponse.Data {
		if item.URL != "" {
			images = append(images, item.URL)
		} else if item.B64JSON != "" {
			images = append(images, "data:image/png;base64,"+item.B64JSON)
		}
	}
	if len(images) == 0 {
		return nil, fmt.Errorf("no image was returned by the model")
	}
	return images, nil
}

func escapeQuotes(value string) string {
	return strings.NewReplacer("\\", "\\\\", `"`, "\\\"").Replace(value)
}

func resolveAIWorkspaceRelayBaseURL(c *gin.Context) string {
	common.OptionMapRWMutex.RLock()
	configured := strings.TrimSpace(common.OptionMap["AIWorkspaceBaseURL"])
	common.OptionMapRWMutex.RUnlock()
	if configured != "" && !isCurrentAIWorkspaceHost(configured, c.Request.Host) {
		return normalizeAIWorkspaceBaseURL(configured)
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = strconv.Itoa(*common.Port)
	}
	return "http://127.0.0.1:" + port
}

func normalizeAIWorkspaceBaseURL(value string) string {
	value = strings.TrimRight(strings.TrimSpace(value), "/")
	return strings.TrimSuffix(value, "/v1")
}

func isCurrentAIWorkspaceHost(value string, requestHost string) bool {
	configuredURL, err := url.Parse(normalizeAIWorkspaceBaseURL(value))
	if err != nil || configuredURL.Host == "" {
		return false
	}
	if sameHost(configuredURL.Host, requestHost) {
		return true
	}
	serverURL, err := url.Parse(system_setting.ServerAddress)
	return err == nil && sameHost(configuredURL.Host, serverURL.Host)
}

func sameHost(left string, right string) bool {
	return strings.EqualFold(strings.TrimSpace(left), strings.TrimSpace(right))
}

func (store *aiWorkspaceTaskStore) add(task *aiWorkspaceImageTask) {
	store.Lock()
	defer store.Unlock()
	store.tasks[task.ID] = task
	store.activeByUser[task.UserID] = task.ID
}

func (store *aiWorkspaceTaskStore) get(id string) *aiWorkspaceImageTask {
	store.Lock()
	defer store.Unlock()
	if task, ok := store.tasks[id]; ok {
		return task.safeCopy()
	}
	return nil
}

func (store *aiWorkspaceTaskStore) activeTaskForUser(userID int) *aiWorkspaceImageTask {
	store.Lock()
	defer store.Unlock()
	taskID := store.activeByUser[userID]
	if taskID == "" {
		return nil
	}
	task := store.tasks[taskID]
	if task == nil || !task.isActive() {
		delete(store.activeByUser, userID)
		return nil
	}
	return task.safeCopy()
}

func (store *aiWorkspaceTaskStore) cancel(id string, userID int) *aiWorkspaceImageTask {
	store.Lock()
	defer store.Unlock()
	task := store.tasks[id]
	if task == nil || task.UserID != userID {
		return nil
	}
	if task.isActive() {
		task.Status = aiWorkspaceTaskCanceled
		task.ExpiresAt = time.Now().Add(aiWorkspaceTaskTTL)
		if task.cancel != nil {
			task.cancel()
		}
		delete(store.activeByUser, userID)
	}
	return task.safeCopy()
}

func (store *aiWorkspaceTaskStore) markRunning(id string) {
	store.Lock()
	defer store.Unlock()
	if task := store.tasks[id]; task != nil && task.Status == aiWorkspaceTaskPending {
		task.Status = aiWorkspaceTaskRunning
	}
}

func (store *aiWorkspaceTaskStore) markSuccess(id string, images []string) {
	store.Lock()
	defer store.Unlock()
	task := store.tasks[id]
	if task == nil || task.Status == aiWorkspaceTaskCanceled {
		return
	}
	task.Status = aiWorkspaceTaskSuccess
	task.Images = images
	task.ExpiresAt = time.Now().Add(aiWorkspaceTaskTTL)
	delete(store.activeByUser, task.UserID)
}

func (store *aiWorkspaceTaskStore) markFailed(id string, message string) {
	store.Lock()
	defer store.Unlock()
	task := store.tasks[id]
	if task == nil || task.Status == aiWorkspaceTaskCanceled {
		return
	}
	task.Status = aiWorkspaceTaskFailed
	task.Error = message
	task.ExpiresAt = time.Now().Add(aiWorkspaceTaskTTL)
	delete(store.activeByUser, task.UserID)
}

func (store *aiWorkspaceTaskStore) markCanceled(id string) {
	store.Lock()
	defer store.Unlock()
	task := store.tasks[id]
	if task == nil {
		return
	}
	task.Status = aiWorkspaceTaskCanceled
	task.ExpiresAt = time.Now().Add(aiWorkspaceTaskTTL)
	delete(store.activeByUser, task.UserID)
}

func (store *aiWorkspaceTaskStore) cleanupExpired() {
	store.Lock()
	defer store.Unlock()
	now := time.Now()
	for id, task := range store.tasks {
		if task.ExpiresAt.After(now) {
			continue
		}
		if task.cancel != nil && task.isActive() {
			task.cancel()
		}
		delete(store.tasks, id)
		if store.activeByUser[task.UserID] == id {
			delete(store.activeByUser, task.UserID)
		}
	}
}

func (task *aiWorkspaceImageTask) isActive() bool {
	return task.Status == aiWorkspaceTaskPending || task.Status == aiWorkspaceTaskRunning
}

func (task *aiWorkspaceImageTask) safeCopy() *aiWorkspaceImageTask {
	if task == nil {
		return nil
	}
	copied := *task
	copied.cancel = nil
	if task.Images != nil {
		copied.Images = append([]string(nil), task.Images...)
	}
	return &copied
}
