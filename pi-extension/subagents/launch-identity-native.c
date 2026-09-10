/* Linux-only Node N-API client: send from the real worker, never a subprocess. */
#define _GNU_SOURCE
#include <node_api.h>
#include <sys/socket.h>
#include <poll.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <time.h>

struct exchange {
  napi_async_work work;
  napi_deferred deferred;
  char request[4097];
  size_t length;
  char response[16385];
  int fd;
};

static long milliseconds(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return now.tv_sec * 1000L + now.tv_nsec / 1000000;
}

static int ready(int fd, short event, long deadline) {
  struct pollfd p = {.fd = fd, .events = event};
  while (1) {
    long remaining = deadline - milliseconds();
    if (remaining <= 0) return 0;
    int result = poll(&p, 1, (int)remaining);
    if (result < 0 && errno == EINTR) continue;
    return result > 0 && (p.revents & event);
  }
}

static void execute(napi_env env, void *data) {
  (void)env;
  struct exchange *x = data;
  long deadline = milliseconds() + 1000;
  if (x->fd < 0 || !ready(x->fd, POLLOUT, deadline)) return;
  if (send(x->fd, x->request, x->length, MSG_NOSIGNAL | MSG_DONTWAIT) != (ssize_t)x->length) return;
  if (!ready(x->fd, POLLIN, deadline)) return;
  ssize_t size = recv(x->fd, x->response, sizeof(x->response) - 1, MSG_DONTWAIT | MSG_TRUNC);
  if (size <= 0 || size >= (ssize_t)sizeof(x->response)) x->response[0] = 0;
  else x->response[size] = 0;
}

static void complete(napi_env env, napi_status status, void *data) {
  struct exchange *x = data;
  napi_value result;
  if (status != napi_ok) x->response[0] = 0;
  napi_create_string_utf8(env, x->response, NAPI_AUTO_LENGTH, &result);
  napi_resolve_deferred(env, x->deferred, result);
  napi_delete_async_work(env, x->work);
  if (x->fd >= 0) close(x->fd);
  free(x);
}

static napi_value exchange_packet(napi_env env, napi_callback_info info) {
  napi_value arg, promise, name;
  size_t argc = 1, size = 0;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  if (argc != 1 || napi_get_value_string_utf8(env, arg, NULL, 0, &size) != napi_ok || size > 4096) {
    napi_throw_type_error(env, NULL, "Expected JSON packet <=4096 bytes");
    return NULL;
  }
  struct exchange *x = calloc(1, sizeof(*x));
  if (!x) { napi_throw_error(env, NULL, "Allocation failed"); return NULL; }
  napi_get_value_string_utf8(env, arg, x->request, sizeof(x->request), &x->length);
  /* Fixed inherited descriptor, not an environment-selected endpoint. */
  x->fd = dup(4);
  int kind = 0;
  socklen_t length = sizeof(kind);
  if (x->fd >= 0 && (getsockopt(x->fd, SOL_SOCKET, SO_TYPE, &kind, &length) != 0 || kind != SOCK_SEQPACKET)) {
    close(x->fd);
    x->fd = -1;
  }
  napi_create_promise(env, &x->deferred, &promise);
  napi_create_string_utf8(env, "resolveSelf", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, NULL, name, execute, complete, x, &x->work);
  napi_queue_async_work(env, x->work);
  return promise;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "exchange", NAPI_AUTO_LENGTH, exchange_packet, NULL, &fn);
  napi_set_named_property(env, exports, "exchange", fn);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
