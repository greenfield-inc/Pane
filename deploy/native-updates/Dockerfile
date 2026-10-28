# The phone app's update server. The build context is the folder that
# native/scripts/build-updates.mts wrote (updates/ and files/).
FROM nginxinc/nginx-unprivileged:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY site/ /usr/share/nginx/html/

EXPOSE 8080
